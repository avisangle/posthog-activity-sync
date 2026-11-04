// TCA-27 red-phase tests: job scheduling helpers and the shared write lease in src/lib/jobs.ts.
//
// External facts (no DB tables):
//  - kv from twenty-sdk/logic-function (2.54.3): get<T>(key, opts?) -> T | null,
//    set(key, value, opts?) -> void, delete(key, opts?) -> boolean. WORKSPACE scope by default,
//    JSON values, no compare-and-set. Mocked here with an in-memory map that JSON-copies values.
//  - stableOffsetMs is 32-bit FNV-1a (basis 0x811c9dc5, prime 0x01000193) over UTF-8 bytes,
//    unsigned, modulo windowMs. Fixtures computed independently:
//    ws-1 -> 2868941829, ws-2 -> 2818608972, 'wś-é' -> 264347197 (a charCode hash gives 1886181 mod 3e6).
//
// Pinned contract: see the "contract" describe at the bottom.
// The module is loaded at runtime by absolute path so this file compiles before it exists.
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

type JobsModule = {
  stableOffsetMs: (workspaceId: string, windowMs: number) => number;
  hourBucketJobId: (prefix: string, now: Date) => string;
  dayBucketJobId: (prefix: string, now: Date) => string;
  acquireLease: (key: string, now: Date, ttlSeconds: number) => Promise<boolean>;
  releaseLease: (key: string) => Promise<void>;
  ACTIVITY_WRITE_LEASE: string;
  JOB_OFFSET_WINDOW_MS: number;
};

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

const loadJobs = async (): Promise<JobsModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/jobs.ts'));

const stored = (key: string) => {
  const raw = kvMock.store.get(key);
  return raw === undefined ? undefined : JSON.parse(raw);
};

beforeEach(() => {
  kvMock.store.clear();
  kvMock.get.mockClear();
  kvMock.set.mockClear();
  kvMock.delete.mockClear();
});

describe('stableOffsetMs', () => {
  it('is FNV-1a over UTF-8 bytes modulo the window, and stable across calls', async () => {
    const { stableOffsetMs } = await loadJobs();

    expect(stableOffsetMs('ws-1', 3_000_000)).toBe(941829);
    expect(stableOffsetMs('ws-2', 3_000_000)).toBe(1608972);
    expect(stableOffsetMs('ws-1', 3_000_000)).toBe(941829);
    expect(stableOffsetMs('wś-é', 3_000_000)).toBe(347197);
    expect(stableOffsetMs('ws-1', 3_600_000)).toBe(3341829);
  });
});

describe('bucket job ids', () => {
  it('formats the UTC hour and day, zero-padded, independent of the input offset', async () => {
    const { hourBucketJobId, dayBucketJobId } = await loadJobs();
    const late = new Date('2026-11-04T23:59:59Z');
    const sameInstantIst = new Date('2026-11-05T05:29:59+05:30');

    expect(hourBucketJobId('posthog-sync', late)).toBe('posthog-sync:2026-11-04T23');
    expect(dayBucketJobId('posthog-recount', late)).toBe('posthog-recount:2026-11-04');
    expect(hourBucketJobId('posthog-sync', sameInstantIst)).toBe('posthog-sync:2026-11-04T23');
    expect(dayBucketJobId('posthog-recount', sameInstantIst)).toBe('posthog-recount:2026-11-04');
    expect(hourBucketJobId('p', new Date('2026-01-02T03:04:05Z'))).toBe('p:2026-01-02T03');
  });
});

describe('lease', () => {
  const now = new Date('2026-11-04T10:00:00.000Z');

  it('refuses a held lease and leaves KV unchanged', async () => {
    const { acquireLease } = await loadJobs();
    kvMock.store.set('k', JSON.stringify({ expiresAt: '2026-11-04T10:00:00.001Z' }));

    expect(await acquireLease('k', now, 600)).toBe(false);
    expect(stored('k')).toEqual({ expiresAt: '2026-11-04T10:00:00.001Z' });
    expect(kvMock.set).not.toHaveBeenCalled();
  });

  it('takes an absent, expired or exactly-expiring lease and stores now + ttl', async () => {
    const { acquireLease } = await loadJobs();
    const expiresAt = (key: string) => Date.parse(stored(key).expiresAt);

    expect(await acquireLease('absent', now, 600)).toBe(true);
    expect(expiresAt('absent')).toBe(now.getTime() + 600_000);

    kvMock.store.set('expired', JSON.stringify({ expiresAt: '2026-11-04T09:00:00.000Z' }));
    expect(await acquireLease('expired', now, 1800)).toBe(true);
    expect(expiresAt('expired')).toBe(now.getTime() + 1_800_000);

    kvMock.store.set('edge', JSON.stringify({ expiresAt: now.toISOString() }));
    expect(await acquireLease('edge', now, 60)).toBe(true);
    expect(typeof stored('edge').expiresAt).toBe('string');
    expect(expiresAt('edge')).toBe(now.getTime() + 60_000);

    // The stored value is what the next acquirer reads: a second job inside the TTL is refused.
    expect(await acquireLease('absent', new Date(now.getTime() + 599_000), 600)).toBe(false);
  });

  it('releaseLease deletes the key', async () => {
    const { acquireLease, releaseLease } = await loadJobs();
    await acquireLease('k', now, 600);

    await releaseLease('k');

    expect(kvMock.store.has('k')).toBe(false);
    expect(kvMock.delete.mock.calls[0][0]).toBe('k');
    expect(await acquireLease('k', now, 600)).toBe(true);
  });
});

describe('contract for TCA-29 / TCA-30 (shape only)', () => {
  it('exports the helpers, ACTIVITY_WRITE_LEASE and JOB_OFFSET_WINDOW_MS', async () => {
    const mod = (await loadJobs()) as unknown as Record<string, unknown>;
    for (const name of [
      'stableOffsetMs',
      'hourBucketJobId',
      'dayBucketJobId',
      'acquireLease',
      'releaseLease',
    ]) {
      expect(typeof mod[name], name).toBe('function');
    }
    const jobs = mod as unknown as JobsModule;

    expect(jobs.ACTIVITY_WRITE_LEASE).toBe('activity-write-lease');
    expect(jobs.JOB_OFFSET_WINDOW_MS).toBe(3_000_000);

    const offset = jobs.stableOffsetMs('any', jobs.JOB_OFFSET_WINDOW_MS);
    expect(Number.isInteger(offset)).toBe(true);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(jobs.JOB_OFFSET_WINDOW_MS);
    expect(typeof jobs.hourBucketJobId('p', new Date())).toBe('string');
    expect(typeof jobs.dayBucketJobId('p', new Date())).toBe('string');
    expect(typeof (await jobs.acquireLease(jobs.ACTIVITY_WRITE_LEASE, new Date(), 60))).toBe(
      'boolean',
    );
    expect(await jobs.releaseLease(jobs.ACTIVITY_WRITE_LEASE)).toBeUndefined();
  });
});
