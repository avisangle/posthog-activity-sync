// TCA-29 red-phase tests: runSync(deps) in src/lib/sync.ts, the hourly sync job body.
//
// External facts (no DB tables; KV, PostHog and Twenty shapes only):
//  - kv from twenty-sdk/logic-function (2.54.3): get<T>(key) -> T | null, set(key, value),
//    delete(key) -> boolean; JSON values. acquireLease/releaseLease (src/lib/jobs.ts) call the
//    module's kv directly, so the module is mocked with an in-memory map and the same fake is
//    passed as deps.kv. `sync:cursor` holds a plain ISO-8601 string.
//  - ACTIVITY_WRITE_LEASE ('activity-write-lease') is the only lease key (D-TCA-27-shared-write-lease).
//  - runQuery({ query, values, name }) -> { columns, results, bytesRead } and
//    PostHogError(kind, detail, { retryAfterSeconds, budgetExceeded }): src/lib/posthog-client.ts.
//  - activeSinceQuery / pageviewCountsQuery / profileUrl: src/lib/queries.ts. activeSince columns are
//    email, last_seen, last_url, person_id; pageviewCounts columns are email, pageviews_30d.
//  - findPeopleByEmails -> Map<lowercased email, PersonSnapshot[]> and writeActivity(changes) ->
//    { written, unchanged }: src/lib/match-people.ts, src/lib/write-activity.ts. Both may throw
//    TwentyRateLimitError (src/lib/twenty-errors.ts). Faked here; Twenty requests are counted as
//    calls to these fakes, since their own batching (50 emails, 200 records) is tested in TCA-27.
//
// Pinned contract for /implement:
//  src/lib/sync.ts exports runSync(deps) and type SyncStatus. deps = { now: () => Date, kv,
//  readSettings, createClient, findPeopleByEmails, writeActivity, log }. runSync resolves to
//  { status: SyncStatus } and never rejects.
//
// The module is loaded at runtime by absolute path so it can be absent in the red phase. The
// type-only import is erased at runtime; `yarn typecheck` fails until the module exists.
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { ACTIVITY_WRITE_LEASE } from 'src/lib/jobs';
import type { PersonSnapshot } from 'src/lib/match-people';
import { PostHogError } from 'src/lib/posthog-client';
import { activeSinceQuery, pageviewCountsQuery, profileUrl } from 'src/lib/queries';
import type { SyncStatus } from 'src/lib/sync';
import { TwentyRateLimitError } from 'src/lib/twenty-errors';

const kvMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => (store.has(key) ? JSON.parse(store.get(key) as string) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, JSON.stringify(value));
    }),
    delete: vi.fn(async (key: string) => store.delete(key)),
  };
});
vi.mock('twenty-sdk/logic-function', () => ({
  kv: { get: kvMock.get, set: kvMock.set, delete: kvMock.delete },
}));

// Guard: the real Twenty client must never be reached from these tests.
const core = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));
vi.mock('twenty-client-sdk/core', () => ({
  CoreApiClient: class {
    query = core.query;
    mutation = core.mutation;
  },
}));

type Settings = { host: string; projectId: string; apiKey: string };
type QueryInput = { query: string; values?: Record<string, unknown>; name: string };
type Rows = { columns: string[]; results: unknown[][]; bytesRead: number | null };
type RunQuery = (input: QueryInput) => Promise<Rows>;
type Next = Partial<{
  posthogLastSeenAt: string | null;
  posthogLastPage: string | null;
  posthogPageviews30d: number | null;
  posthogProfile: string | null;
}>;
type Change = { snapshot: PersonSnapshot; next: Next };
type Deps = {
  now: () => Date;
  kv: { get: typeof kvMock.get; set: typeof kvMock.set; delete: typeof kvMock.delete };
  readSettings: () => { ok: true; settings: Settings } | { ok: false; problems: { key: string; reason: string }[] };
  createClient: (settings: Settings, options?: { timeoutMs?: number }) => { runQuery: RunQuery };
  findPeopleByEmails: (emails: string[]) => Promise<Map<string, PersonSnapshot[]>>;
  writeActivity: (changes: Change[]) => Promise<{ written: number; unchanged: number }>;
  log: (...args: unknown[]) => void;
};
type SyncModule = { runSync: (deps: Deps) => Promise<{ status: string }> };

const loadSync = async (): Promise<SyncModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/sync.ts'));

const NOW = new Date('2026-11-05T12:00:00.000Z');
const WINDOW_END = '2026-11-05T11:50:00.000Z'; // now - 10 min
const THIRTY_DAYS_BEFORE_NOW = '2026-10-06T12:00:00.000Z';
const CURSOR = 'sync:cursor';
const SETTINGS: Settings = { host: 'https://eu.posthog.com', projectId: '777', apiKey: 'phx_test' };

// Identify each built query by its text, never by call order.
const ACTIVE_SQL = activeSinceQuery({ since: new Date(0), until: new Date(1), limit: 1 }).query;
const COUNTS_SQL = pageviewCountsQuery({ emails: ['x@example.com'], now: NOW }).query;

const activeRows = (results: unknown[][]): Rows => ({
  columns: ['email', 'last_seen', 'last_url', 'person_id'],
  results,
  bytesRead: 2048,
});
const countRows = (results: unknown[][]): Rows => ({
  columns: ['email', 'pageviews_30d'],
  results,
  bytesRead: 1024,
});

const ALICE_ROW = ['alice@example.com', '2026-11-05T11:00:00Z', 'https://site.test/pricing', 'ph-alice'];
const BOB_ROW = ['bob@example.com', '2026-11-05T11:10:00Z', 'https://site.test/docs', 'ph-bob'];
const CAROL_ROW = ['carol@example.com', '2026-11-05T11:20:00Z', 'https://site.test/', 'ph-carol'];

const snapshot = (id: string, email: string): PersonSnapshot =>
  ({
    id,
    email,
    posthogLastSeenAt: null,
    posthogLastPage: null,
    posthogPageviews30d: null,
    posthogProfile: null,
  }) as PersonSnapshot;

// Two Twenty people share alice's email; carol is not in Twenty.
const ALICE_A = snapshot('0b7c2a51-1d2e-4f3a-8b4c-5d6e7f809a1b', 'alice@example.com');
const ALICE_B = snapshot('1c8d3b62-2e3f-4a4b-9c5d-6e7f8091ab2c', 'alice@example.com');
const BOB = snapshot('2d9e4c73-3f4a-4b5c-ad6e-7f8091a2bc3d', 'bob@example.com');
const matches = () =>
  new Map<string, PersonSnapshot[]>([
    ['alice@example.com', [ALICE_A, ALICE_B]],
    ['bob@example.com', [BOB]],
  ]);

type Scripted = Rows | Error;

// Every dep is a spy. `active` and `counts` are scripted responses consumed in order.
const makeDeps = ({
  active = [activeRows([])],
  counts = [countRows([])],
  overrides = {},
}: { active?: Scripted[]; counts?: Scripted[]; overrides?: Partial<Deps> } = {}) => {
  const queues = { active: [...active], counts: [...counts] };
  const take = (queue: Scripted[], label: string) => {
    const next = queue.shift();
    if (next === undefined) throw new Error(`unscripted ${label} query`);
    if (next instanceof Error) throw next;
    return next;
  };
  const runQuery = vi.fn<RunQuery>(async (input) => {
    if (input.query === ACTIVE_SQL) return take(queues.active, 'activeSince');
    if (input.query === COUNTS_SQL) return take(queues.counts, 'pageviewCounts');
    throw new Error(`unexpected query: ${input.query}`);
  });
  const spies = {
    now: vi.fn<Deps['now']>(() => NOW),
    kv: { get: kvMock.get, set: kvMock.set, delete: kvMock.delete },
    readSettings: vi.fn<Deps['readSettings']>(() => ({ ok: true, settings: SETTINGS })),
    createClient: vi.fn<Deps['createClient']>(() => ({ runQuery })),
    // Like the real one: only emails it was asked for come back.
    findPeopleByEmails: vi.fn<Deps['findPeopleByEmails']>(
      async (emails) => new Map([...matches()].filter(([email]) => emails.includes(email))),
    ),
    writeActivity: vi.fn<Deps['writeActivity']>(async (changes) => ({ written: changes.length, unchanged: 0 })),
    log: vi.fn<Deps['log']>(),
  };
  // Overrides are vi.fn spies too, so the spy types still hold.
  const deps = { ...spies, ...overrides } as typeof spies;
  return { deps, runQuery };
};

const callsTo = (runQuery: ReturnType<typeof makeDeps>['runQuery'], sql: string) =>
  runQuery.mock.calls.map(([input]) => input).filter((input) => input.query === sql);

const stored = (key: string) => {
  const raw = kvMock.store.get(key);
  return raw === undefined ? undefined : JSON.parse(raw);
};
const preload = (key: string, value: unknown) => kvMock.store.set(key, JSON.stringify(value));

const allChanges = (deps: ReturnType<typeof makeDeps>['deps']) =>
  deps.writeActivity.mock.calls.flatMap(([changes]) => changes);

beforeEach(() => {
  kvMock.store.clear();
  kvMock.get.mockClear();
  kvMock.set.mockClear();
  kvMock.delete.mockClear();
  core.query.mockReset();
  core.mutation.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('real fetch must not be called');
    }),
  );
});

afterEach(() => {
  expect(core.query).not.toHaveBeenCalled();
  expect(core.mutation).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('contract for TCA-32: runSync and the sync:cursor KV key (shape only)', () => {
  it('exports runSync, resolves to { status }, and leaves sync:cursor as an ISO-8601 string', async () => {
    const sync = (await loadSync()) as unknown as Record<string, unknown>;
    expect(typeof sync.runSync).toBe('function');

    // Checked by `yarn typecheck`; a no-op at runtime.
    expectTypeOf<SyncStatus>().toEqualTypeOf<
      'ok' | 'locked' | 'not_configured' | 'idle' | 'rate_limited' | 'timeout' | 'error'
    >();

    const { deps } = makeDeps({ active: [activeRows([ALICE_ROW])], counts: [countRows([])] });
    const result = await (sync as unknown as SyncModule).runSync(deps);
    expect(typeof result.status).toBe('string');

    const cursor = stored(CURSOR);
    expect(typeof cursor).toBe('string');
    expect(new Date(cursor).toISOString()).toBe(cursor);
  });
});

describe('runSync: happy path', () => {
  it('first run: lease 330 s before settings, window now-30d..now-10min, counts for matched only, cursor = windowEnd', async () => {
    const { runSync } = await loadSync();
    const { deps, runQuery } = makeDeps({
      active: [activeRows([ALICE_ROW, BOB_ROW, CAROL_ROW])],
      counts: [countRows([['alice@example.com', 7]])],
    });

    await expect(runSync(deps)).resolves.toMatchObject({ status: 'ok' });

    // Step 1: the shared lease, TTL 330 s, taken before anything else runs; released at the end.
    const leaseSet = kvMock.set.mock.calls.findIndex(([key]) => key === ACTIVITY_WRITE_LEASE);
    expect(leaseSet).toBeGreaterThanOrEqual(0);
    expect(kvMock.set.mock.calls[leaseSet][1]).toEqual({
      expiresAt: new Date(NOW.getTime() + 330_000).toISOString(),
    });
    expect(kvMock.set.mock.invocationCallOrder[leaseSet]).toBeLessThan(
      deps.readSettings.mock.invocationCallOrder[0],
    );
    expect(kvMock.store.has(ACTIVITY_WRITE_LEASE)).toBe(false);
    expect(deps.createClient.mock.calls[0][0]).toEqual(SETTINGS);

    // Steps 3 and 4.
    const [active] = callsTo(runQuery, ACTIVE_SQL);
    expect(active.values).toEqual(
      activeSinceQuery({ since: new Date(THIRTY_DAYS_BEFORE_NOW), until: new Date(WINDOW_END), limit: 5000 })
        .values,
    );

    // Step 5: every returned email; step 6: one counts query for matched emails only.
    expect(deps.findPeopleByEmails).toHaveBeenCalledTimes(1);
    expect([...deps.findPeopleByEmails.mock.calls[0][0]].sort()).toEqual([
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
    ]);
    const [counts] = callsTo(runQuery, COUNTS_SQL);
    expect([...(counts.values?.emails as string[])].sort()).toEqual(['alice@example.com', 'bob@example.com']);
    expect(counts.values?.since).toBe(THIRTY_DAYS_BEFORE_NOW);

    // Step 7: one change per matched snapshot, only snapshots from this run's read.
    expect(deps.writeActivity).toHaveBeenCalledTimes(1);
    const changes = allChanges(deps);
    expect(changes).toHaveLength(3);
    for (const change of changes) expect([ALICE_A, ALICE_B, BOB]).toContain(change.snapshot);
    const nextFor = (person: PersonSnapshot) => changes.find((c) => c.snapshot === person)?.next;
    const aliceNext = {
      posthogLastSeenAt: '2026-11-05T11:00:00.000Z',
      posthogLastPage: 'https://site.test/pricing',
      posthogPageviews30d: 7,
      posthogProfile: profileUrl(SETTINGS.host, SETTINGS.projectId, 'ph-alice'),
    };
    expect(nextFor(ALICE_A)).toEqual(aliceNext);
    expect(nextFor(ALICE_B)).toEqual(aliceNext);
    expect(nextFor(BOB)).toEqual({
      posthogLastSeenAt: '2026-11-05T11:10:00.000Z',
      posthogLastPage: 'https://site.test/docs',
      posthogPageviews30d: 0, // absent from the counts map
      posthogProfile: profileUrl(SETTINGS.host, SETTINGS.projectId, 'ph-bob'),
    });

    // Step 8 and the budget: 2 PostHog queries, one Twenty read call, one write call.
    expect(stored(CURSOR)).toBe(WINDOW_END);
    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalled();
  });

  it('second run with no new events: reads from the cursor, zero writes, no counts query, cursor advances', async () => {
    const { runSync } = await loadSync();
    preload(CURSOR, '2026-11-05T10:50:00.000Z');
    const { deps, runQuery } = makeDeps({ active: [activeRows([])] });

    await expect(runSync(deps)).resolves.toMatchObject({ status: 'ok' });

    expect(callsTo(runQuery, ACTIVE_SQL)[0].values?.since).toBe('2026-11-05T10:50:00.000Z');
    expect(callsTo(runQuery, COUNTS_SQL)).toHaveLength(0);
    expect(allChanges(deps)).toHaveLength(0);
    expect(stored(CURSOR)).toBe(WINDOW_END);

    // Rows that match nobody in Twenty also skip the counts query and still advance.
    preload(CURSOR, '2026-11-05T10:50:00.000Z');
    const unmatched = makeDeps({
      active: [activeRows([CAROL_ROW])],
      overrides: { findPeopleByEmails: vi.fn(async () => new Map<string, PersonSnapshot[]>()) },
    });
    await expect(runSync(unmatched.deps)).resolves.toMatchObject({ status: 'ok' });
    expect(callsTo(unmatched.runQuery, COUNTS_SQL)).toHaveLength(0);
    expect(allChanges(unmatched.deps)).toHaveLength(0);
    expect(stored(CURSOR)).toBe(WINDOW_END);
  });

  it('a null last URL leaves posthogLastPage out of next; the other three fields are still set', async () => {
    const { runSync } = await loadSync();
    const customOnly = ['bob@example.com', '2026-11-05T11:10:00Z', null, 'ph-bob'];
    const { deps } = makeDeps({
      active: [activeRows([customOnly])],
      counts: [countRows([['bob@example.com', 3]])],
    });

    await expect(runSync(deps)).resolves.toMatchObject({ status: 'ok' });

    const [change] = allChanges(deps);
    expect(change.snapshot).toBe(BOB);
    expect('posthogLastPage' in change.next).toBe(false);
    expect(change.next).toEqual({
      posthogLastSeenAt: '2026-11-05T11:10:00.000Z',
      posthogPageviews30d: 3,
      posthogProfile: profileUrl(SETTINGS.host, SETTINGS.projectId, 'ph-bob'),
    });
  });

  it('a result at the 5,000 cap sets the cursor to the last row last_seen; 4,999 rows uses windowEnd', async () => {
    const { runSync } = await loadSync();
    const rowsOf = (n: number) =>
      Array.from({ length: n }, (_, i) => [
        `user${i}@example.com`,
        new Date(Date.parse('2026-11-05T10:00:00Z') + i * 1000).toISOString(),
        'https://site.test/',
        `ph-${i}`,
      ]);
    const none = { findPeopleByEmails: vi.fn(async () => new Map<string, PersonSnapshot[]>()) };

    const capped = makeDeps({ active: [activeRows(rowsOf(5000))], overrides: none });
    await expect(runSync(capped.deps)).resolves.toMatchObject({ status: 'ok' });
    expect(stored(CURSOR)).toBe('2026-11-05T11:23:19.000Z'); // row 4999: 10:00:00 + 4,999 s

    kvMock.store.clear();
    const under = makeDeps({ active: [activeRows(rowsOf(4999))], overrides: none });
    await expect(runSync(under.deps)).resolves.toMatchObject({ status: 'ok' });
    expect(stored(CURSOR)).toBe(WINDOW_END);
  });
});

describe('runSync: guards', () => {
  it('lease held by a running recount: returns locked, makes zero calls and leaves its lease in place', async () => {
    const { runSync } = await loadSync();
    const recountLease = { expiresAt: '2026-11-05T12:03:00.000Z' };
    preload(ACTIVITY_WRITE_LEASE, recountLease);
    preload(CURSOR, '2026-11-05T10:50:00.000Z');
    const { deps, runQuery } = makeDeps();

    await expect(runSync(deps)).resolves.toMatchObject({ status: 'locked' });

    expect(deps.readSettings).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
    expect(deps.findPeopleByEmails).not.toHaveBeenCalled();
    expect(deps.writeActivity).not.toHaveBeenCalled();
    expect(kvMock.set).not.toHaveBeenCalled();
    expect(kvMock.delete).not.toHaveBeenCalled();
    expect(stored(ACTIVITY_WRITE_LEASE)).toEqual(recountLease);
    expect(stored(CURSOR)).toBe('2026-11-05T10:50:00.000Z');
  });

  it('not configured: logs, returns not_configured, makes zero PostHog calls and releases the lease', async () => {
    const { runSync } = await loadSync();
    const { deps, runQuery } = makeDeps({
      overrides: {
        readSettings: vi.fn(() => ({
          ok: false as const,
          problems: [{ key: 'POSTHOG_PROJECT_ID', reason: 'Enter the PostHog project ID.' }],
        })),
      },
    });

    await expect(runSync(deps)).resolves.toMatchObject({ status: 'not_configured' });

    expect(runQuery).not.toHaveBeenCalled();
    expect(deps.findPeopleByEmails).not.toHaveBeenCalled();
    expect(deps.writeActivity).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
    expect(kvMock.store.has(CURSOR)).toBe(false);
    expect(kvMock.store.has(ACTIVITY_WRITE_LEASE)).toBe(false);
  });

  it.each(['2026-11-05T11:50:00.000Z', '2026-11-05T11:55:00.000Z'])(
    'cursor %s at or after windowEnd: returns idle with no PostHog call',
    async (cursor) => {
      const { runSync } = await loadSync();
      preload(CURSOR, cursor);
      const { deps, runQuery } = makeDeps();

      await expect(runSync(deps)).resolves.toMatchObject({ status: 'idle' });

      expect(runQuery).not.toHaveBeenCalled();
      expect(deps.findPeopleByEmails).not.toHaveBeenCalled();
      expect(stored(CURSOR)).toBe(cursor);
      expect(kvMock.store.has(ACTIVITY_WRITE_LEASE)).toBe(false);
    },
  );
});

describe('runSync: failures keep the cursor, release the lease and never throw', () => {
  const START = '2026-11-05T09:50:00.000Z';

  it('PostHog 429: logs retryAfterSeconds and budgetExceeded, returns rate_limited; the next run resumes from the cursor', async () => {
    const { runSync } = await loadSync();
    preload(CURSOR, START);
    const limited = new PostHogError('rate_limited', 'HTTP 429: budget', {
      retryAfterSeconds: 4242,
      budgetExceeded: true,
    });
    const first = makeDeps({ active: [limited] });

    await expect(runSync(first.deps)).resolves.toMatchObject({ status: 'rate_limited' });

    expect(stored(CURSOR)).toBe(START);
    expect(kvMock.store.has(ACTIVITY_WRITE_LEASE)).toBe(false);
    expect(first.deps.findPeopleByEmails).not.toHaveBeenCalled();
    const logged = JSON.stringify(first.deps.log.mock.calls);
    expect(logged).toContain('4242');
    expect(logged).toMatch(/budget/i);

    const later = new Date(NOW.getTime() + 3_600_000);
    const second = makeDeps({
      active: [activeRows([ALICE_ROW])],
      counts: [countRows([['alice@example.com', 1]])],
      overrides: { now: vi.fn(() => later) },
    });
    await expect(runSync(second.deps)).resolves.toMatchObject({ status: 'ok' });
    expect(callsTo(second.runQuery, ACTIVE_SQL)[0].values?.since).toBe(START);
    expect(stored(CURSOR)).toBe('2026-11-05T12:50:00.000Z');
  });

  it('PostHog timeout on activeSince: retries once up to the midpoint and advances the cursor there (3 queries)', async () => {
    const { runSync } = await loadSync();
    preload(CURSOR, START);
    const { deps, runQuery } = makeDeps({
      active: [new PostHogError('timeout', 'HTTP 504'), activeRows([ALICE_ROW])],
      counts: [countRows([['alice@example.com', 2]])],
    });

    await expect(runSync(deps)).resolves.toMatchObject({ status: 'ok' });

    const [firstTry, retry] = callsTo(runQuery, ACTIVE_SQL);
    expect(firstTry.values).toMatchObject({ since: START, until: WINDOW_END, limit: 5000 });
    expect(retry.values).toMatchObject({ since: START, until: '2026-11-05T10:50:00.000Z', limit: 5000 });
    expect(runQuery).toHaveBeenCalledTimes(3);
    expect(allChanges(deps)).toHaveLength(2);
    expect(stored(CURSOR)).toBe('2026-11-05T10:50:00.000Z');
    expect(kvMock.store.has(ACTIVITY_WRITE_LEASE)).toBe(false);
  });

  it('a second timeout returns timeout after exactly 2 queries and keeps the cursor', async () => {
    const { runSync } = await loadSync();
    preload(CURSOR, START);
    const { deps, runQuery } = makeDeps({
      active: [new PostHogError('timeout', 'HTTP 504'), new PostHogError('timeout', 'HTTP 504')],
    });

    await expect(runSync(deps)).resolves.toMatchObject({ status: 'timeout' });

    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(deps.findPeopleByEmails).not.toHaveBeenCalled();
    expect(stored(CURSOR)).toBe(START);
    expect(kvMock.store.has(ACTIVITY_WRITE_LEASE)).toBe(false);
  });

  it.each([
    {
      label: 'timeout on the counts query',
      status: 'timeout',
      setup: { counts: [new PostHogError('timeout', 'HTTP 504')] },
    },
    {
      label: 'TwentyRateLimitError from findPeopleByEmails',
      status: 'rate_limited',
      setup: {
        overrides: { findPeopleByEmails: vi.fn(async () => Promise.reject(new TwentyRateLimitError())) },
      },
    },
    {
      label: 'TwentyRateLimitError from writeActivity',
      status: 'rate_limited',
      setup: { overrides: { writeActivity: vi.fn(async () => Promise.reject(new TwentyRateLimitError())) } },
    },
    {
      label: 'PostHog unauthorized on activeSince',
      status: 'error',
      setup: { active: [new PostHogError('unauthorized', 'HTTP 401')] },
    },
    {
      label: 'a plain Error from findPeopleByEmails',
      status: 'error',
      setup: { overrides: { findPeopleByEmails: vi.fn(async () => Promise.reject(new Error('boom'))) } },
    },
  ] as { label: string; status: string; setup: Parameters<typeof makeDeps>[0] }[])(
    '$label returns $status',
    async ({ status, setup }) => {
      const { runSync } = await loadSync();
      preload(CURSOR, START);
      const { deps, runQuery } = makeDeps({
        active: [activeRows([ALICE_ROW, BOB_ROW])],
        counts: [countRows([['alice@example.com', 7]])],
        ...setup,
      });

      await expect(runSync(deps)).resolves.toMatchObject({ status });

      expect(stored(CURSOR)).toBe(START);
      expect(kvMock.store.has(ACTIVITY_WRITE_LEASE)).toBe(false);
      expect(runQuery.mock.calls.length).toBeLessThanOrEqual(2);
    },
  );
});
