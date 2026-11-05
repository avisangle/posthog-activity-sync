import { RECOUNT_JOB_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import {
  acquireLease,
  ACTIVITY_WRITE_LEASE,
  dayBucketJobId,
  enqueueBucketedJob,
  jobFailureStatus,
  releaseLease,
  type JobFailureStatus,
} from 'src/lib/jobs';
import {
  addByEmail,
  findRecentlySeenPeople,
  type ActivityValues,
  type PersonSnapshot,
} from 'src/lib/match-people';
import { createPostHogClient, errorText } from 'src/lib/posthog-client';
import {
  DAY_MS,
  PAGEVIEW_WINDOW_DAYS,
  pageviewCountsQuery,
  parsePageviewCounts,
} from 'src/lib/queries';
import { readSettings, type SettingsResult } from 'src/lib/settings';
import { clearActivity, writeActivity, type ActivityChange } from 'src/lib/write-activity';

// Clear scope: D-TCA-30-gdpr-clear-scope. Scheduling and lease: D-TCA-27-job-scheduling,
// D-TCA-27-shared-write-lease.

export type RecountStatus = 'ok' | 'locked' | 'not_configured' | JobFailureStatus;

type Tally = { people: number; batches: number; written: number; cleared: number; bytesRead: number };

export type RecountResult = Tally & { status: RecountStatus };

type RecountDeps = {
  now: () => Date;
  readSettings: () => SettingsResult;
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

const JOB_PREFIX = 'posthog-recount';
// The page-view window plus a day of slack, so every count that can still decay is recounted.
const RECENT_WINDOW_MS = (PAGEVIEW_WINDOW_DAYS + 1) * DAY_MS;
const EMAILS_PER_QUERY = 500;
export const RECOUNT_TIMEOUT_SECONDS = 300;
const LEASE_TTL_SECONDS = RECOUNT_TIMEOUT_SECONDS + 30;

export const enqueueRecount = (workspaceId: string, now: Date = new Date()) =>
  enqueueBucketedJob(RECOUNT_JOB_FUNCTION_UNIVERSAL_IDENTIFIER, dayBucketJobId(JOB_PREFIX, now), workspaceId);

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
    const result = await runQuery({ ...pageviewCountsQuery({ emails: batch, now }), name: 'recount-pageview-counts' });
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
  let leased = false;
  try {
    leased = await acquireLease(ACTIVITY_WRITE_LEASE, now, LEASE_TTL_SECONDS);
    status = leased ? await recount(deps, now, tally) : 'locked';
  } catch (error) {
    status = jobFailureStatus(error);
    reason = ` (${errorText(error)})`;
  } finally {
    // A failed release must not replace the run's own status; the lease expires on its own.
    if (leased) {
      await releaseLease(ACTIVITY_WRITE_LEASE).catch((error) =>
        deps.log(`posthog-recount: could not release the write lease (${errorText(error)})`),
      );
    }
  }
  deps.log(
    `posthog-recount: ${status}${reason}: people=${tally.people} batches=${tally.batches} ` +
      `written=${tally.written} cleared=${tally.cleared} bytesRead=${tally.bytesRead}`,
  );
  return { status, ...tally };
};
