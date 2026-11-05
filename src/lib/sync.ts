import { enqueueJobs, kv } from 'twenty-sdk/logic-function';

import { SYNC_JOB_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import {
  ACTIVITY_WRITE_LEASE,
  JOB_OFFSET_WINDOW_MS,
  acquireLease,
  hourBucketJobId,
  releaseLease,
  stableOffsetMs,
} from 'src/lib/jobs';
import { findPeopleByEmails, type ActivityValues, type PersonSnapshot } from 'src/lib/match-people';
import {
  createPostHogClient,
  PostHogError,
  type QueryResult,
  type RunQueryInput,
} from 'src/lib/posthog-client';
import {
  activeSinceQuery,
  pageviewCountsQuery,
  parseActiveRows,
  parsePageviewCounts,
  profileUrl,
  type ActiveRow,
} from 'src/lib/queries';
import { readSettings, type PostHogSettings, type SettingsResult } from 'src/lib/settings';
import { TwentyRateLimitError } from 'src/lib/twenty-errors';
import { writeActivity, type ActivityChange } from 'src/lib/write-activity';

// Flow and failure paths: TCA-20 "Hourly sync". Scheduling and lease: D-TCA-27-job-scheduling,
// D-TCA-27-shared-write-lease.

export type SyncStatus =
  | 'ok'
  | 'locked'
  | 'not_configured'
  | 'idle'
  | 'rate_limited'
  | 'timeout'
  | 'error';

export type SyncDeps = {
  now: () => Date;
  kv: Pick<typeof kv, 'get' | 'set' | 'delete'>;
  readSettings: () => SettingsResult;
  createClient: (
    settings: PostHogSettings,
    options?: { timeoutMs?: number },
  ) => { runQuery: (input: RunQueryInput) => Promise<QueryResult> };
  findPeopleByEmails: typeof findPeopleByEmails;
  writeActivity: typeof writeActivity;
  log: (...args: unknown[]) => void;
};

export const SYNC_CURSOR_KEY = 'sync:cursor';

const JOB_PREFIX = 'posthog-sync';
// Above the job's timeoutSeconds (300), per D-TCA-27-shared-write-lease.
const LEASE_TTL_SECONDS = 330;
// Late-ingested events carry earlier timestamps; this lag keeps them inside a later window.
const INGESTION_LAG_MS = 10 * 60_000;
const FIRST_RUN_LOOKBACK_MS = 30 * 86_400_000;
const ROW_LIMIT = 5000;

const DEFAULT_DEPS: SyncDeps = {
  now: () => new Date(),
  kv,
  readSettings,
  createClient: createPostHogClient,
  findPeopleByEmails,
  writeActivity,
  log: console.log,
};

// The cron's whole job: one bucketed, delayed enqueue, never retried by the queue.
export const enqueueSync = (workspaceId: string, now: Date = new Date()) =>
  enqueueJobs({
    logicFunctionUniversalIdentifier: SYNC_JOB_FUNCTION_UNIVERSAL_IDENTIFIER,
    jobs: [{ jobId: hourBucketJobId(JOB_PREFIX, now) }],
    delayMs: stableOffsetMs(workspaceId, JOB_OFFSET_WINDOW_MS),
    retryLimit: 0,
  });

const midpoint = (a: Date, b: Date) => new Date(Math.floor((a.getTime() + b.getTime()) / 2));

const isTimeout = (error: unknown) => error instanceof PostHogError && error.kind === 'timeout';

const statusFor = (error: unknown): SyncStatus => {
  if (error instanceof TwentyRateLimitError) return 'rate_limited';
  if (error instanceof PostHogError && error.kind === 'rate_limited') return 'rate_limited';
  return isTimeout(error) ? 'timeout' : 'error';
};

const describeError = (error: unknown) =>
  error instanceof PostHogError
    ? {
        kind: error.kind,
        detail: error.detail,
        retryAfterSeconds: error.retryAfterSeconds,
        budgetExceeded: error.budgetExceeded,
      }
    : { error: error instanceof Error ? error.message : String(error) };

const nextValues = (
  row: ActiveRow,
  pageviews: number,
  settings: PostHogSettings,
): Partial<ActivityValues> => ({
  posthogLastSeenAt: row.lastSeenAt,
  // A window holding only custom events must not blank the last page.
  ...(row.lastUrl !== null && { posthogLastPage: row.lastUrl }),
  posthogPageviews30d: pageviews,
  posthogProfile: profileUrl(settings.host, settings.projectId, row.personRef),
});

// Runs with the lease held. Throws on any failure; the cursor moves only at the end.
const syncWindow = async (deps: SyncDeps, now: Date): Promise<SyncStatus> => {
  const config = deps.readSettings();
  if (!config.ok) {
    deps.log('posthog-sync: not configured', config.problems.map((problem) => problem.key));
    return 'not_configured';
  }
  const { settings } = config;

  const stored = await deps.kv.get<string>(SYNC_CURSOR_KEY);
  const since = stored ? new Date(stored) : new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
  const windowEnd = new Date(now.getTime() - INGESTION_LAG_MS);
  if (since >= windowEnd) return 'idle';

  const client = deps.createClient(settings);
  let queries = 0;
  let bytesRead = 0;
  const run = async (input: RunQueryInput) => {
    queries += 1;
    const result = await client.runQuery(input);
    bytesRead += result.bytesRead ?? 0;
    return result;
  };
  const activeSince = async (until: Date) =>
    parseActiveRows(
      await run({ ...activeSinceQuery({ since, until, limit: ROW_LIMIT }), name: 'sync-active-since' }),
    );

  let until = windowEnd;
  let rows: ActiveRow[];
  try {
    rows = await activeSince(until);
  } catch (error) {
    if (!isTimeout(error)) throw error;
    until = midpoint(since, windowEnd);
    deps.log('posthog-sync: activeSince timed out, retrying up to', until.toISOString());
    rows = await activeSince(until);
  }

  const people: Map<string, PersonSnapshot[]> =
    rows.length > 0 ? await deps.findPeopleByEmails(rows.map((row) => row.email)) : new Map();
  // findPeopleByEmails keys by trimmed, lowercased email; PostHog already lowercased it.
  const matched = rows.flatMap((row) => {
    const snapshots = people.get(row.email.trim());
    return snapshots ? [{ row, snapshots }] : [];
  });

  let written = 0;
  if (matched.length > 0) {
    const counts = parsePageviewCounts(
      await run({
        ...pageviewCountsQuery({ emails: matched.map(({ row }) => row.email), now }),
        name: 'sync-pageview-counts',
      }),
    );
    const changes: ActivityChange[] = matched.flatMap(({ row, snapshots }) =>
      snapshots.map((snapshot) => ({
        snapshot,
        next: nextValues(row, counts.get(row.email) ?? 0, settings),
      })),
    );
    ({ written } = await deps.writeActivity(changes));
  }

  // At the cap, resume from the last row read; `>=` re-reads its ties, harmless with diff-only writes.
  const cursor = rows.length === ROW_LIMIT ? rows[rows.length - 1].lastSeenAt : until.toISOString();
  await deps.kv.set(SYNC_CURSOR_KEY, cursor);

  deps.log('posthog-sync: done', {
    window: { since: since.toISOString(), until: until.toISOString() },
    rows: rows.length,
    matched: matched.length,
    written,
    posthogQueries: queries,
    bytesRead,
  });
  return 'ok';
};

// Never rejects: a throw would only add queue retries.
export const runSync = async (overrides: Partial<SyncDeps> = {}): Promise<{ status: SyncStatus }> => {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const now = deps.now();
  let leased = false;
  try {
    leased = await acquireLease(ACTIVITY_WRITE_LEASE, now, LEASE_TTL_SECONDS);
    if (!leased) {
      deps.log('posthog-sync: write lease held by another job, skipping this run');
      return { status: 'locked' };
    }
    return { status: await syncWindow(deps, now) };
  } catch (error) {
    const status = statusFor(error);
    deps.log(`posthog-sync: stopped (${status}), cursor kept`, describeError(error));
    return { status };
  } finally {
    if (leased) {
      await releaseLease(ACTIVITY_WRITE_LEASE).catch((error) =>
        deps.log('posthog-sync: could not release the write lease', describeError(error)),
      );
    }
  }
};
