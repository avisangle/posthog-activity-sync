// TCA-29 guards added in /implement, beyond the issue's letter: only http(s) last URLs become
// links, and a capped page tied at the cursor cannot stall it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonSnapshot } from 'src/lib/match-people';
import type { QueryResult } from 'src/lib/posthog-client';
import { runSync, type SyncDeps } from 'src/lib/sync';

const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock('twenty-sdk/logic-function', () => ({
  kv: {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: unknown) => void store.set(key, value),
    delete: async (key: string) => store.delete(key),
  },
}));
vi.mock('twenty-client-sdk/core', () => ({ CoreApiClient: class {} }));

const NOW = new Date('2026-11-05T12:00:00.000Z');
const SETTINGS = { host: 'https://us.posthog.com', projectId: '1', apiKey: 'phx_test' };
const BOB = { id: 'b0b', email: 'bob@example.com' } as PersonSnapshot;

const deps = (activeRows: unknown[][], writeActivity = vi.fn(async () => ({ written: 1, unchanged: 0 }))) => {
  const runQuery = vi.fn(async ({ name }: { name: string }): Promise<QueryResult> =>
    name === 'sync-active-since'
      ? { columns: ['email', 'last_seen', 'last_url', 'person_id'], results: activeRows, bytesRead: null }
      : { columns: ['email', 'pageviews_30d'], results: [['bob@example.com', 1]], bytesRead: null },
  );
  const overrides: Partial<SyncDeps> = {
    now: () => NOW,
    readSettings: () => ({ ok: true, settings: SETTINGS }),
    createClient: () => ({ runQuery }),
    findPeopleByEmails: vi.fn(async (emails: string[]) =>
      new Map(emails.includes('bob@example.com') ? [['bob@example.com', [BOB]]] : []),
    ),
    writeActivity,
    log: vi.fn(),
  };
  return { overrides, writeActivity };
};

beforeEach(() => store.clear());

describe('runSync guards', () => {
  it.each(['javascript:alert(1)', 'data:text/html,x', 'not a url'])(
    'leaves a %s last URL out of next',
    async (url) => {
      const { overrides, writeActivity } = deps([['bob@example.com', '2026-11-05T11:00:00Z', url, 'ph-bob']]);
      await expect(runSync(overrides)).resolves.toEqual({ status: 'ok' });
      const [[changes]] = writeActivity.mock.calls as unknown as [[{ next: object }[]]];
      expect('posthogLastPage' in changes[0].next).toBe(false);
    },
  );

  it('keeps an http last URL', async () => {
    const { overrides, writeActivity } = deps([['bob@example.com', '2026-11-05T11:00:00Z', 'http://site.test/a', 'ph-bob']]);
    await runSync(overrides);
    const [[changes]] = writeActivity.mock.calls as unknown as [[{ next: { posthogLastPage?: string } }[]]];
    expect(changes[0].next.posthogLastPage).toBe('http://site.test/a');
  });

  it('a full page whose last row ties the cursor moves the cursor 1 ms past it', async () => {
    const since = '2026-11-05T10:00:00.000Z';
    store.set('sync:cursor', since);
    const rows = Array.from({ length: 5000 }, (_, i) => [`u${i}@example.com`, since, null, `ph-${i}`]);
    const { overrides } = deps(rows);
    await expect(runSync(overrides)).resolves.toEqual({ status: 'ok' });
    expect(store.get('sync:cursor')).toBe('2026-11-05T10:00:00.001Z');
  });
});
