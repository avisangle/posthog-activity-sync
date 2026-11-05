// TCA-30 red-phase tests: runRecount() in src/lib/recount.ts, the daily cron in
// src/logic-functions/recount-cron.function.ts, the job in recount-job.function.ts, and the
// decision record D-TCA-30-gdpr-clear-scope.
//
// External facts (no DB tables; Twenty Core API and PostHog shapes only):
//  - findRecentlySeenPeople(since) -> PersonSnapshot[] (src/lib/match-people.ts); email is trimmed,
//    lowercased, null when blank. PersonSnapshot is branded, so fixtures cast `as PersonSnapshot`.
//  - writeActivity(changes: { snapshot, next }[]) -> { written, unchanged } and clearActivity()
//    (all four null) in src/lib/write-activity.ts; the writer is diff-only and makes one
//    createPeople mutation per 200 changed records through `new CoreApiClient()`.
//  - pageviewCountsQuery({ emails, now }) / parsePageviewCounts(rows) in src/lib/queries.ts;
//    result columns ['email', 'pageviews_30d']; an email absent from the rows is not in PostHog.
//  - PostHogError(kind, detail) in src/lib/posthog-client.ts; TwentyRateLimitError in
//    src/lib/twenty-errors.ts.
//  - acquireLease/releaseLease use `kv` from twenty-sdk/logic-function (get/set/delete, JSON
//    values); the only lease key is ACTIVITY_WRITE_LEASE = 'activity-write-lease' (src/lib/jobs.ts).
//  - twenty-sdk 2.54.3: enqueueJobs({ logicFunctionUniversalIdentifier, jobs: [{ jobId }],
//    delayMs, retryLimit }); a handler gets (payload, context) with context.workspaceId;
//    defineLogicFunction(...) returns { success, config, errors }.
//  - stableOffsetMs('ws-1', 50 min) = 2868941829 % 3_000_000 = 941829 (60 min would give 3341829).
//
// Pinned contract for /implement:
//  src/lib/recount.ts exports runRecount(deps?: Partial<RecountDeps>) -> Promise<{ status, ... }>,
//  deps = { now, readSettings, createClient, findRecentlySeenPeople, writeActivity, log }, each
//  defaulting to the real one (same shape as TCA-29's runSync). KV is not a dep: the lease goes
//  through jobs.ts, so the fake KV is the twenty-sdk/logic-function module mock.
//  status: 'ok' | 'locked' | 'not_configured' | 'rate_limited' | 'timeout' | 'error'.
//  writeActivity is called once per 500-email batch, right after that batch's query.
//
// New modules load at runtime by absolute path so they can be absent in the red phase. The
// type-only import below is erased at runtime; `yarn typecheck` fails until the module exists.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi, type Mock } from 'vitest';

import * as identifiers from 'src/constants/universal-identifiers';
import { ACTIVITY_WRITE_LEASE } from 'src/lib/jobs';
import type { ActivityValues, PersonSnapshot } from 'src/lib/match-people';
import { PostHogError } from 'src/lib/posthog-client';
import { pageviewCountsQuery } from 'src/lib/queries';
import type { runRecount as RunRecount } from 'src/lib/recount';
import { TwentyRateLimitError } from 'src/lib/twenty-errors';
import { clearActivity } from 'src/lib/write-activity';

const { kvMock, enqueueJobs, sdk } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    kvMock: {
      store,
      get: vi.fn(async (key: string) => (store.has(key) ? JSON.parse(store.get(key) as string) : null)),
      set: vi.fn(async (key: string, value: unknown) => {
        store.set(key, JSON.stringify(value));
      }),
      delete: vi.fn(async (key: string) => store.delete(key)),
    },
    enqueueJobs: vi.fn(async () => ({
      enqueued: true,
      logicFunctionUniversalIdentifier: 'x',
      enqueuedJobsCount: 1,
      jobIds: ['x'],
    })),
    sdk: { query: vi.fn(), mutation: vi.fn() },
  };
});

vi.mock('twenty-sdk/logic-function', () => ({
  kv: { get: kvMock.get, set: kvMock.set, delete: kvMock.delete },
  enqueueJobs,
}));

vi.mock('twenty-client-sdk/core', () => ({
  CoreApiClient: class {
    query = sdk.query;
    mutation = sdk.mutation;
  },
}));

type Settings = { host: string; projectId: string; apiKey: string };
type QueryInput = { query: string; values?: Record<string, unknown>; name: string };
type RunQuery = (input: QueryInput) => Promise<{ columns: string[]; results: unknown[][]; bytesRead: number | null }>;
type Change = { snapshot: PersonSnapshot; next: Partial<ActivityValues> };
type Deps = {
  now: () => Date;
  readSettings: () => { ok: true; settings: Settings } | { ok: false; problems: unknown[] };
  createClient: (settings: Settings, options?: { timeoutMs?: number }) => { runQuery: RunQuery };
  findRecentlySeenPeople: (since: Date) => Promise<PersonSnapshot[]>;
  writeActivity: (changes: Change[]) => Promise<{ written: number; unchanged: number }>;
  log: (line: string) => void;
};
type Result = { status: string };
type RecountModule = { runRecount: (deps?: Partial<Deps>) => Promise<Result> };
type FunctionModule = {
  default: {
    success: boolean;
    errors: string[];
    config: {
      universalIdentifier: string;
      timeoutSeconds?: number;
      cronTriggerSettings?: { pattern: string };
      handler: (payload: unknown, context: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

const loadRecount = async (): Promise<RecountModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/recount.ts'));
const loadCron = async (): Promise<FunctionModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/logic-functions/recount-cron.function.ts'));
const loadJob = async (): Promise<FunctionModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/logic-functions/recount-job.function.ts'));

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOW = new Date('2026-11-05T03:30:00.000Z');
const THIRTY_ONE_DAYS_BEFORE_NOW = '2026-10-05T03:30:00.000Z';
const SETTINGS: Settings = { host: 'https://us.posthog.com', projectId: '1', apiKey: 'phx_recount_key' };
const PROFILE = 'https://us.posthog.com/project/1/person/u-1';
const SEEN = '2026-11-01T10:00:00.000Z';
const LEASE_TTL_MS = 330_000;

let seq = 0;
const person = (email: string | null, count: number | null = 5): PersonSnapshot =>
  ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    email,
    posthogLastSeenAt: SEEN,
    posthogLastPage: 'https://acme.com/pricing',
    posthogPageviews30d: count,
    posthogProfile: PROFILE,
  }) as PersonSnapshot;

// A fake PostHog that answers each counts query from `counts`; emails not in it are absent.
const fakePostHog = (counts: Record<string, number>) =>
  vi.fn<RunQuery>(async ({ values }) => {
    const emails = (values?.emails as string[]) ?? [];
    return {
      columns: ['email', 'pageviews_30d'],
      results: emails.filter((e) => e in counts).map((e) => [e, counts[e]]),
      bytesRead: 2048,
    };
  });

type MockDeps = { [K in keyof Deps]: Mock<Deps[K]> };

const makeDeps = (people: PersonSnapshot[], counts: Record<string, number>, overrides: Partial<Deps> = {}) => {
  const runQuery = fakePostHog(counts);
  const deps: MockDeps = {
    now: vi.fn<Deps['now']>(() => NOW),
    readSettings: vi.fn<Deps['readSettings']>(() => ({ ok: true, settings: SETTINGS })),
    createClient: vi.fn<Deps['createClient']>(() => ({ runQuery })),
    findRecentlySeenPeople: vi.fn<Deps['findRecentlySeenPeople']>(async () => people),
    writeActivity: vi.fn<Deps['writeActivity']>(async (changes) => ({ written: changes.length, unchanged: 0 })),
    log: vi.fn<Deps['log']>(),
    // Every override in this file is a vi.fn mock.
    ...(overrides as Partial<MockDeps>),
  };
  return { deps, runQuery };
};

const writtenChanges = (deps: { writeActivity: ReturnType<typeof vi.fn> }): Change[] =>
  deps.writeActivity.mock.calls.flatMap(([changes]) => changes as Change[]);

const storedLease = () => {
  const raw = kvMock.store.get(ACTIVITY_WRITE_LEASE);
  return raw === undefined ? undefined : JSON.parse(raw);
};

beforeEach(() => {
  seq = 0;
  kvMock.store.clear();
  kvMock.get.mockClear();
  kvMock.set.mockClear();
  kvMock.delete.mockClear();
  enqueueJobs.mockClear();
  sdk.query.mockReset();
  sdk.mutation.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('contract for TCA-32: the daily recount and the documented GDPR clear limit', () => {
  it('exports runRecount and records D-TCA-30-gdpr-clear-scope with the 31-day limit', async () => {
    const recount = await loadRecount();
    expect(typeof recount.runRecount).toBe('function');

    // Checked by `yarn typecheck`; a no-op at runtime.
    expectTypeOf<Awaited<ReturnType<typeof RunRecount>>['status']>().toEqualTypeOf<
      'ok' | 'locked' | 'not_configured' | 'rate_limited' | 'timeout' | 'error'
    >();

    const path = resolve(process.cwd(), 'docs/decisions/D-TCA-30-gdpr-clear-scope.md');
    expect(existsSync(path)).toBe(true);
    const record = readFileSync(path, 'utf8');
    expect(record).toMatch(/^\*\*Status:\*\* \S/m);
    expect(record).toMatch(/\*\*Issue:\*\* TCA-30/);
    // The exact limit the README (TCA-32) restates.
    expect(record).toContain('posthogLastSeenAt');
    expect(record).toMatch(/31 days/);
  });
});

describe('runRecount: counts and clears', () => {
  it('reads people seen in the last 31 days, and a changed count passes next = { posthogPageviews30d } only', async () => {
    const { runRecount } = await loadRecount();
    const ada = person('ada@example.com', 5);
    const { deps, runQuery } = makeDeps([ada], { 'ada@example.com': 7 });

    await expect(runRecount(deps)).resolves.toMatchObject({ status: 'ok' });

    expect(deps.findRecentlySeenPeople).toHaveBeenCalledTimes(1);
    expect(deps.findRecentlySeenPeople.mock.calls[0][0].toISOString()).toBe(THIRTY_ONE_DAYS_BEFORE_NOW);
    // The 30-day window comes from the job's `now` (D-TCA-24-caller-clock-windows).
    const built = pageviewCountsQuery({ emails: ['ada@example.com'], now: NOW });
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0][0]).toMatchObject({ query: built.query, values: built.values });

    expect(writtenChanges(deps)).toEqual([{ snapshot: ada, next: { posthogPageviews30d: 7 } }]);
    expect(deps.log).toHaveBeenCalledTimes(1);
  });

  it('an unchanged count makes no Twenty write request (real diff-only writer)', async () => {
    const { runRecount } = await loadRecount();
    const ada = person('ada@example.com', 4);
    const { deps } = makeDeps([ada], { 'ada@example.com': 4 });
    const withRealWriter: Partial<Deps> = { ...deps };
    delete withRealWriter.writeActivity;

    await expect(runRecount(withRealWriter)).resolves.toMatchObject({ status: 'ok' });
    expect(sdk.mutation).not.toHaveBeenCalled();
  });

  it('an email absent from PostHog persons passes next = clearActivity(); shared emails update every person', async () => {
    const { runRecount } = await loadRecount();
    const gone = person('gone@example.com', 9);
    const twinA = person('twin@example.com', 1);
    const twinB = person('twin@example.com', 2);
    const { deps, runQuery } = makeDeps([gone, twinA, twinB], { 'twin@example.com': 3 });

    await expect(runRecount(deps)).resolves.toMatchObject({ status: 'ok' });

    // Grouped by email: one query, each email bound once.
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect([...(runQuery.mock.calls[0][0].values?.emails as string[])].sort()).toEqual([
      'gone@example.com',
      'twin@example.com',
    ]);

    const changes = writtenChanges(deps);
    expect(changes).toHaveLength(3);
    expect(changes.find((c) => c.snapshot === gone)?.next).toEqual(clearActivity());
    expect(clearActivity()).toEqual({
      posthogLastSeenAt: null,
      posthogLastPage: null,
      posthogPageviews30d: null,
      posthogProfile: null,
    });
    expect(changes.find((c) => c.snapshot === twinA)?.next).toEqual({ posthogPageviews30d: 3 });
    expect(changes.find((c) => c.snapshot === twinB)?.next).toEqual({ posthogPageviews30d: 3 });
  });

  it('1,200 people make 3 PostHog queries of at most 500 emails, each followed by its own write', async () => {
    const { runRecount } = await loadRecount();
    const people = Array.from({ length: 1200 }, (_, i) => person(`p${i}@example.com`, 0));
    const counts = Object.fromEntries(people.map((p, i) => [p.email as string, i + 1]));
    const { deps, runQuery } = makeDeps(people, counts);

    await expect(runRecount(deps)).resolves.toMatchObject({ status: 'ok' });

    expect(runQuery).toHaveBeenCalledTimes(3);
    const sizes = runQuery.mock.calls.map(([input]) => (input.values?.emails as string[]).length);
    expect(sizes.every((n) => n <= 500)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1200);
    expect(deps.writeActivity).toHaveBeenCalledTimes(3);
    expect(writtenChanges(deps)).toHaveLength(1200);
  });

  it('skips people without an email, and makes no PostHog query when none has one', async () => {
    const { runRecount } = await loadRecount();
    const ada = person('ada@example.com', 1);
    const blank = person(null, 6);
    const { deps, runQuery } = makeDeps([ada, blank], { 'ada@example.com': 2 });

    await expect(runRecount(deps)).resolves.toMatchObject({ status: 'ok' });
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0][0].values?.emails).toEqual(['ada@example.com']);
    expect(writtenChanges(deps).map((c) => c.snapshot)).toEqual([ada]);

    const onlyBlank = makeDeps([person(null, 6)], {});
    await expect(runRecount(onlyBlank.deps)).resolves.toMatchObject({ status: 'ok' });
    expect(onlyBlank.runQuery).not.toHaveBeenCalled();
    expect(writtenChanges(onlyBlank.deps)).toEqual([]);
  });
});

describe('runRecount: lease and settings', () => {
  it('holds ACTIVITY_WRITE_LEASE for 330 s while it works, and releases it afterwards', async () => {
    const { runRecount } = await loadRecount();
    let leaseDuringRead: unknown;
    const { deps } = makeDeps([person('ada@example.com', 1)], { 'ada@example.com': 2 }, {
      findRecentlySeenPeople: vi.fn(async () => {
        leaseDuringRead = storedLease();
        return [person('ada@example.com', 1)];
      }),
    });

    await expect(runRecount(deps)).resolves.toMatchObject({ status: 'ok' });
    expect(leaseDuringRead).toEqual({ expiresAt: new Date(NOW.getTime() + LEASE_TTL_MS).toISOString() });
    expect(storedLease()).toBeUndefined();
  });

  it('a lease held by a running sync returns locked, makes no calls and leaves the lease alone', async () => {
    const { runRecount } = await loadRecount();
    const held = { expiresAt: new Date(NOW.getTime() + 60_000).toISOString() };
    kvMock.store.set(ACTIVITY_WRITE_LEASE, JSON.stringify(held));
    const { deps, runQuery } = makeDeps([person('ada@example.com')], { 'ada@example.com': 1 });

    await expect(runRecount(deps)).resolves.toMatchObject({ status: 'locked' });

    expect(deps.readSettings).not.toHaveBeenCalled();
    expect(deps.findRecentlySeenPeople).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
    expect(deps.writeActivity).not.toHaveBeenCalled();
    expect(storedLease()).toEqual(held);
  });

  it('not configured returns not_configured with no Twenty or PostHog call, and releases the lease', async () => {
    const { runRecount } = await loadRecount();
    const { deps, runQuery } = makeDeps([person('ada@example.com')], { 'ada@example.com': 1 }, {
      readSettings: vi.fn(() => ({ ok: false as const, problems: [{ key: 'POSTHOG_HOST', reason: 'x' }] })),
    });

    await expect(runRecount(deps)).resolves.toMatchObject({ status: 'not_configured' });
    expect(deps.findRecentlySeenPeople).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
    expect(deps.writeActivity).not.toHaveBeenCalled();
    expect(storedLease()).toBeUndefined();
  });
});

describe('runRecount: failures stop without throwing', () => {
  it('a PostHog 429 on the second batch keeps the first batch written, stops, and releases the lease', async () => {
    const { runRecount } = await loadRecount();
    const people = Array.from({ length: 1200 }, (_, i) => person(`p${i}@example.com`, 0));
    const counts = Object.fromEntries(people.map((p) => [p.email as string, 1]));
    const { deps, runQuery } = makeDeps(people, counts);
    const answer = runQuery.getMockImplementation() as RunQuery;
    runQuery
      .mockImplementationOnce(answer)
      .mockImplementationOnce(async () => {
        throw new PostHogError('rate_limited', 'HTTP 429: throttled', { retryAfterSeconds: 30 });
      });

    await expect(runRecount(deps)).resolves.toMatchObject({ status: 'rate_limited' });
    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(deps.writeActivity).toHaveBeenCalledTimes(1);
    expect(storedLease()).toBeUndefined();
  });

  it('maps a Twenty throttle, a PostHog timeout and any other error to a status, never a throw', async () => {
    const { runRecount } = await loadRecount();
    const cases: [Partial<Deps>, string][] = [
      [{ writeActivity: vi.fn(async () => Promise.reject(new TwentyRateLimitError())) }, 'rate_limited'],
      [{ findRecentlySeenPeople: vi.fn(async () => Promise.reject(new TwentyRateLimitError())) }, 'rate_limited'],
      [
        {
          createClient: vi.fn(() => ({
            runQuery: vi.fn(async () => Promise.reject(new PostHogError('timeout', 'HTTP 504: slow'))),
          })),
        },
        'timeout',
      ],
      [{ writeActivity: vi.fn(async () => Promise.reject(new Error('boom'))) }, 'error'],
    ];

    for (const [override, status] of cases) {
      kvMock.store.clear();
      const { deps } = makeDeps([person('ada@example.com', 1)], { 'ada@example.com': 2 }, override);
      await expect(runRecount(deps)).resolves.toMatchObject({ status });
      expect(storedLease()).toBeUndefined();
    }
  });
});

describe('recount cron and job functions', () => {
  it('the cron runs at 03:30 UTC and only enqueues the job with the day bucket id and the 50-minute offset', async () => {
    const cron = (await loadCron()).default;
    const job = (await loadJob()).default;
    expect(cron.errors).toEqual([]);
    expect(cron.config.cronTriggerSettings).toEqual({ pattern: '30 3 * * *' });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T03:30:00.000Z'));
    await cron.config.handler({}, {
      workspaceId: 'ws-1',
      retryCount: 0,
      maxRetries: 0,
      userWorkspaceId: null,
      workspaceMemberId: null,
    });

    expect(enqueueJobs).toHaveBeenCalledTimes(1);
    expect(enqueueJobs).toHaveBeenCalledWith({
      logicFunctionUniversalIdentifier: job.config.universalIdentifier,
      jobs: [{ jobId: 'posthog-recount:2026-11-05' }],
      delayMs: 941829,
      retryLimit: 0,
    });
    // Enqueue only: no lease, no Twenty or PostHog work in the cron.
    expect(kvMock.set).not.toHaveBeenCalled();
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it('the job has a 300 s timeout, declared v4 ids, and its handler runs runRecount with the real deps', async () => {
    const cron = (await loadCron()).default;
    const job = (await loadJob()).default;
    expect(job.errors).toEqual([]);
    expect(job.config.timeoutSeconds).toBe(300);
    expect(job.config.cronTriggerSettings).toBeUndefined();

    const declared = Object.values(identifiers);
    for (const id of [cron.config.universalIdentifier, job.config.universalIdentifier]) {
      expect(id).toMatch(UUID_V4);
      expect(declared.filter((value) => value === id)).toHaveLength(1);
    }
    expect(cron.config.universalIdentifier).not.toBe(job.config.universalIdentifier);

    for (const key of ['POSTHOG_HOST', 'POSTHOG_CUSTOM_HOST', 'POSTHOG_PROJECT_ID', 'POSTHOG_PERSONAL_API_KEY']) {
      vi.stubEnv(key, '');
    }
    await expect(job.config.handler({}, { workspaceId: 'ws-1' })).resolves.toMatchObject({
      status: 'not_configured',
    });
    // The real path took and released the shared lease, and read no people.
    expect(kvMock.set).toHaveBeenCalledWith(ACTIVITY_WRITE_LEASE, expect.anything());
    expect(storedLease()).toBeUndefined();
    expect(sdk.query).not.toHaveBeenCalled();
  });
});
