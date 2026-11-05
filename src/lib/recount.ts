import { acquireLease, ACTIVITY_WRITE_LEASE, releaseLease } from 'src/lib/jobs';
import {
  addByEmail,
  findRecentlySeenPeople,
  type ActivityValues,
  type PersonSnapshot,
} from 'src/lib/match-people';
import { createPostHogClient, PostHogError } from 'src/lib/posthog-client';
import { pageviewCountsQuery, parsePageviewCounts } from 'src/lib/queries';
import { readSettings } from 'src/lib/settings';
import { TwentyRateLimitError } from 'src/lib/twenty-errors';
import { clearActivity, writeActivity, type ActivityChange } from 'src/lib/write-activity';

// Clear scope: D-TCA-30-gdpr-clear-scope. Lease: D-TCA-27-shared-write-lease.

export type RecountStatus = 'ok' | 'locked' | 'not_configured' | 'rate_limited' | 'timeout' | 'error';

type Tally = { people: number; batches: number; written: number; cleared: number; bytesRead: number };

export type RecountResult = Tally & { status: RecountStatus };

type RecountDeps = {
  now: () => Date;
  readSettings: () => ReturnType<typeof readSettings>;
  createClient: typeof createPostHogClient;
  findRecentlySeenPeople: typeof findRecentlySeenPeople;
  writeActivity: typeof writeActivity;
  log: (line: string) => void;
};

const DEFAULT_DEPS: RecountDeps = {
  now: () => new Date(),
  readSettings,
  createClient: createPostHogClient,
  findRecentlySeenPeople,
  writeActivity,
  log: (line) => console.log(line),
};

const RECENT_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const EMAILS_PER_QUERY = 500;
export const RECOUNT_TIMEOUT_SECONDS = 300;
const LEASE_TTL_SECONDS = RECOUNT_TIMEOUT_SECONDS + 30;

const statusFor = (error: unknown): RecountStatus => {
  if (error instanceof TwentyRateLimitError) return 'rate_limited';
  if (error instanceof PostHogError && (error.kind === 'rate_limited' || error.kind === 'timeout')) {
    return error.kind;
  }
  return 'error';
};

// One PostHog query per 500 emails, each batch written before the next query.
const recount = async (deps: RecountDeps, now: Date, tally: Tally): Promise<RecountStatus> => {
  const settings = deps.readSettings();
  if (!settings.ok) return 'not_configured';

  const people = await deps.findRecentlySeenPeople(new Date(now.getTime() - RECENT_WINDOW_MS));
  tally.people = people.length;
  const byEmail = new Map<string, PersonSnapshot[]>();
  for (const person of people) if (person.email !== null) addByEmail(byEmail, person);
  const emails = [...byEmail.keys()];
  const { runQuery } = deps.createClient(settings.settings);

  for (let i = 0; i < emails.length; i += EMAILS_PER_QUERY) {
    const batch = emails.slice(i, i + EMAILS_PER_QUERY);
    const result = await runQuery({ ...pageviewCountsQuery({ emails: batch, now }), name: 'recount' });
    tally.batches += 1;
    tally.bytesRead += result.bytesRead ?? 0;

    const counts = parsePageviewCounts(result);
    const changes: ActivityChange[] = batch.flatMap((email) => {
      const group = byEmail.get(email)!;
      const count = counts.get(email);
      let next: Partial<ActivityValues> = { posthogPageviews30d: count };
      if (count === undefined) {
        // Absent from PostHog persons: deleted there, so clear all four fields.
        next = clearActivity();
        tally.cleared += group.length;
      }
      return group.map((snapshot) => ({ snapshot, next }));
    });
    tally.written += (await deps.writeActivity(changes)).written;
  }
  return 'ok';
};

// Never throws. Batches written before a failure stay written; the next day's run redoes the rest.
export const runRecount = async (overrides: Partial<RecountDeps> = {}): Promise<RecountResult> => {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const now = deps.now();
  const tally: Tally = { people: 0, batches: 0, written: 0, cleared: 0, bytesRead: 0 };
  let status: RecountStatus;
  let reason = '';
  try {
    if (!(await acquireLease(ACTIVITY_WRITE_LEASE, now, LEASE_TTL_SECONDS))) {
      return { status: 'locked', ...tally };
    }
    try {
      status = await recount(deps, now, tally);
    } finally {
      await releaseLease(ACTIVITY_WRITE_LEASE);
    }
  } catch (error) {
    status = statusFor(error);
    reason = ` (${error instanceof Error ? error.message : String(error)})`;
  }
  deps.log(
    `posthog recount ${status}${reason}: people=${tally.people} batches=${tally.batches} ` +
      `written=${tally.written} cleared=${tally.cleared} bytesRead=${tally.bytesRead}`,
  );
  return { status, ...tally };
};
