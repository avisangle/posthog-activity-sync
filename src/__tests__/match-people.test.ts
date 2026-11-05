// TCA-27 red-phase tests: findPeopleByEmails, findRecentlySeenPeople, escapeLike in
// src/lib/match-people.ts, and their rate-limit rethrow (src/lib/twenty-errors.ts).
//
// External facts (no DB tables; Twenty GraphQL through CoreApiClient):
//  - Person fields (TCA-25, src/fields/*): posthogLastSeenAt DATE_TIME, posthogLastPage LINKS,
//    posthogPageviews30d NUMBER, posthogProfile LINKS. Email is emails.primaryEmail.
//  - CoreApiClient is genql only, created in-function (D-TCA-ga-api-shapes, Decision 2). Its typings
//    are `any` until the app client is generated, so `query` resolves the data object directly:
//    { people: { edges: [{ node }], pageInfo: { hasNextPage, endCursor } } }.
//  - primaryEmail.in is case-sensitive, ilike is not (D-TCA-22 Evidence, Twenty). `_` and `%` are
//    ilike wildcards. A cleared LINKS field reads back as primaryLinkUrl ''.
//  - A non-2xx Twenty response throws Error(`${statusText}: ${rawBody}`) (twenty-client-sdk 2.54.3).
//
// Pinned contract: see the "contract" describe at the bottom.
// Modules are loaded at runtime by absolute path so this file compiles before they exist.
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Snapshot = {
  id: string;
  email: string | null;
  posthogLastSeenAt: string | null;
  posthogLastPage: string | null;
  posthogPageviews30d: number | null;
  posthogProfile: string | null;
};
type MatchModule = {
  findPeopleByEmails: (emails: string[]) => Promise<Map<string, Snapshot[]>>;
  findRecentlySeenPeople: (since: Date) => Promise<Snapshot[]>;
  escapeLike: (s: string) => string;
};
type ErrorsModule = {
  TwentyRateLimitError: new (...args: never[]) => Error;
  isTwentyRateLimit: (error: unknown) => boolean;
};

const sdk = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), constructed: 0 }));
vi.mock('twenty-client-sdk/core', () => ({
  CoreApiClient: class {
    query = sdk.query;
    mutation = sdk.mutation;
    constructor() {
      sdk.constructed += 1;
    }
  },
}));

const loadMatch = async (): Promise<MatchModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/match-people.ts'));
const loadErrors = async (): Promise<ErrorsModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/twenty-errors.ts'));

type NodeInput = {
  id: string;
  email?: string | null;
  lastSeen?: string | null;
  pageviews?: number | null;
  page?: string | null;
  profile?: string | null;
};
const node = (n: NodeInput) => ({
  id: n.id,
  emails: { primaryEmail: n.email ?? null },
  posthogLastSeenAt: n.lastSeen ?? null,
  posthogPageviews30d: n.pageviews ?? null,
  posthogLastPage: { primaryLinkUrl: n.page ?? null },
  posthogProfile: { primaryLinkUrl: n.profile ?? null },
});
const page = (
  nodes: ReturnType<typeof node>[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
) => ({ people: { edges: nodes.map((n) => ({ node: n })), pageInfo } });

type PeopleArgs = { filter: unknown; first: number; after?: string };
const peopleArgs = (call: number): PeopleArgs => sdk.query.mock.calls[call][0].people.__args;
const ilikeValues = (call: number): string[] =>
  (peopleArgs(call).filter as { or: { emails: { primaryEmail: { ilike: string } } }[] }).or.map(
    (c) => c.emails.primaryEmail.ilike,
  );

const SELECTION = {
  id: true,
  emails: { primaryEmail: true },
  posthogLastSeenAt: true,
  posthogPageviews30d: true,
  posthogLastPage: { primaryLinkUrl: true },
  posthogProfile: { primaryLinkUrl: true },
};

beforeEach(() => {
  sdk.query.mockReset();
  sdk.mutation.mockReset();
  sdk.constructed = 0;
});

describe('findPeopleByEmails', () => {
  it('matches case-insensitively and keys the map by the trimmed, lowercased email', async () => {
    const { findPeopleByEmails } = await loadMatch();
    sdk.query.mockResolvedValueOnce(
      page([
        node({
          id: 'p-1',
          email: 'maya@acme.com',
          lastSeen: '2026-11-03T23:10:00Z',
          pageviews: 5,
          page: 'https://acme.com/app',
          profile: 'https://us.posthog.com/project/1/persons/u-1',
        }),
      ]),
    );

    const map = await findPeopleByEmails([' Maya@Acme.com', 'maya@acme.com']);

    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(peopleArgs(0)).toEqual({
      filter: { or: [{ emails: { primaryEmail: { ilike: 'maya@acme.com' } } }] },
      first: 100,
    });
    expect(sdk.query.mock.calls[0][0].people.edges.node).toEqual(SELECTION);
    expect(sdk.query.mock.calls[0][0].people.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: true,
    });
    expect([...map.keys()]).toEqual(['maya@acme.com']);
    expect(map.get('maya@acme.com')).toEqual([
      {
        id: 'p-1',
        email: 'maya@acme.com',
        posthogLastSeenAt: '2026-11-03T23:10:00Z',
        posthogPageviews30d: 5,
        posthogLastPage: 'https://acme.com/app',
        posthogProfile: 'https://us.posthog.com/project/1/persons/u-1',
      },
    ]);
  });

  it('escapes ilike wildcards and drops rows that are not an exact email match', async () => {
    const { findPeopleByEmails, escapeLike } = await loadMatch();
    expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');

    sdk.query.mockResolvedValueOnce(
      page([
        node({ id: 'wild', email: 'johnxdoe@x.com' }),
        node({ id: 'blank', email: '' }),
        node({ id: 'none', email: null }),
      ]),
    );

    const map = await findPeopleByEmails(['john_doe@x.com']);

    expect(ilikeValues(0)).toEqual(['john\\_doe@x.com']);
    const ids = [...map.values()].flat().map((s) => s.id);
    expect(ids).toEqual([]);
    expect(map.get('john_doe@x.com') ?? []).toEqual([]);
  });

  it('returns both people when two share an email, and LINKS stored as empty read as null', async () => {
    const { findPeopleByEmails } = await loadMatch();
    sdk.query.mockResolvedValueOnce(
      page([
        node({ id: 'p-1', email: 'maya@acme.com', page: '', profile: '' }),
        node({ id: 'p-2', email: ' Maya@Acme.com ', page: null, profile: 'https://ph/x' }),
      ]),
    );

    const map = await findPeopleByEmails(['maya@acme.com']);
    const entry = map.get('maya@acme.com') ?? [];

    expect(entry.map((s) => s.id).sort()).toEqual(['p-1', 'p-2']);
    expect(entry.map((s) => s.email)).toEqual(['maya@acme.com', 'maya@acme.com']);
    const p1 = entry.find((s) => s.id === 'p-1');
    expect(p1?.posthogLastPage).toBeNull();
    expect(p1?.posthogProfile).toBeNull();
    expect(entry.find((s) => s.id === 'p-2')?.posthogProfile).toBe('https://ph/x');
  });

  it('queries in batches of 50 and follows endCursor while hasNextPage is true', async () => {
    const { findPeopleByEmails } = await loadMatch();
    const emails = Array.from({ length: 120 }, (_, i) => `u${i}@x.com`);
    // Answers by request, so batches may run in any order. Batch 2 (u50..u99) has a second page.
    sdk.query.mockImplementation(async (q: { people: { __args: PeopleArgs } }) => {
      const args = q.people.__args;
      const first = (args.filter as { or: { emails: { primaryEmail: { ilike: string } } }[] })
        .or[0].emails.primaryEmail.ilike;
      if (args.after === 'cur-1') return page([node({ id: 'c', email: 'u51@x.com' })]);
      if (first === 'u50@x.com')
        return page([node({ id: 'b', email: 'u50@x.com' })], {
          hasNextPage: true,
          endCursor: 'cur-1',
        });
      if (first === 'u0@x.com') return page([node({ id: 'a', email: 'u0@x.com' })]);
      return page([node({ id: 'd', email: 'u119@x.com' })]);
    });

    const map = await findPeopleByEmails(emails);

    expect(sdk.query).toHaveBeenCalledTimes(4);
    const calls = [0, 1, 2, 3];
    const firstPages = calls.filter((c) => peopleArgs(c).after === undefined);
    expect(firstPages.map((c) => ilikeValues(c).length).sort()).toEqual([20, 50, 50]);
    expect(firstPages.flatMap(ilikeValues).sort()).toEqual([...emails].sort());
    const nextPage = calls.find((c) => peopleArgs(c).after === 'cur-1');
    expect(nextPage).toBeDefined();
    const batch2 = firstPages.find((c) => ilikeValues(c)[0] === 'u50@x.com') as number;
    expect(peopleArgs(nextPage as number)).toEqual({ ...peopleArgs(batch2), after: 'cur-1' });
    expect(calls.every((c) => peopleArgs(c).first === 100)).toBe(true);
    expect([...map.values()].flat().map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('makes no request for an empty list and creates its CoreApiClient per call', async () => {
    const { findPeopleByEmails } = await loadMatch();

    expect((await findPeopleByEmails([])).size).toBe(0);
    expect(sdk.query).not.toHaveBeenCalled();

    sdk.query.mockResolvedValue(page([]));
    await findPeopleByEmails(['a@x.com']);
    await findPeopleByEmails(['b@x.com']);
    expect(sdk.constructed).toBeGreaterThanOrEqual(2);
  });

  it('rethrows a throttled read as TwentyRateLimitError and any other error unchanged', async () => {
    const { findPeopleByEmails } = await loadMatch();
    const { TwentyRateLimitError } = await loadErrors();

    sdk.query.mockRejectedValueOnce(new Error('Too Many Requests: {"statusCode":429}'));
    await expect(findPeopleByEmails(['a@x.com'])).rejects.toBeInstanceOf(TwentyRateLimitError);

    const boom = new Error('Internal Server Error: boom');
    sdk.query.mockRejectedValueOnce(boom);
    const rejection = findPeopleByEmails(['a@x.com']);
    await expect(rejection).rejects.toBe(boom);
    await expect(rejection).rejects.not.toBeInstanceOf(TwentyRateLimitError);
  });
});

describe('findRecentlySeenPeople', () => {
  it('pages people seen since `since` and keeps those without a primary email as email: null', async () => {
    const { findRecentlySeenPeople } = await loadMatch();
    const since = new Date('2026-11-04T10:00:00+05:30');
    sdk.query
      .mockResolvedValueOnce(
        page([node({ id: 'p-1', email: ' Maya@Acme.com', lastSeen: '2026-11-04T05:00:00Z' })], {
          hasNextPage: true,
          endCursor: 'cur-9',
        }),
      )
      .mockResolvedValueOnce(
        page([
          node({ id: 'p-2', email: '', pageviews: 0, page: '' }),
          { ...node({ id: 'p-3' }), emails: null as never },
        ]),
      );

    const people = await findRecentlySeenPeople(since);

    expect(sdk.query).toHaveBeenCalledTimes(2);
    expect(peopleArgs(0)).toEqual({
      filter: { posthogLastSeenAt: { gte: '2026-11-04T04:30:00.000Z' } },
      first: 100,
    });
    expect(peopleArgs(1)).toEqual({ ...peopleArgs(0), after: 'cur-9' });
    expect(sdk.query.mock.calls[0][0].people.edges.node).toEqual(SELECTION);
    expect(people).toEqual([
      {
        id: 'p-1',
        email: 'maya@acme.com',
        posthogLastSeenAt: '2026-11-04T05:00:00Z',
        posthogPageviews30d: null,
        posthogLastPage: null,
        posthogProfile: null,
      },
      {
        id: 'p-2',
        email: null,
        posthogLastSeenAt: null,
        posthogPageviews30d: 0,
        posthogLastPage: null,
        posthogProfile: null,
      },
      {
        id: 'p-3',
        email: null,
        posthogLastSeenAt: null,
        posthogPageviews30d: null,
        posthogLastPage: null,
        posthogProfile: null,
      },
    ]);
  });

  it('rethrows a throttled read as TwentyRateLimitError', async () => {
    const { findRecentlySeenPeople } = await loadMatch();
    const { TwentyRateLimitError } = await loadErrors();

    sdk.query.mockRejectedValueOnce(new Error('ThrottlerException: Too Many Requests'));
    await expect(findRecentlySeenPeople(new Date())).rejects.toBeInstanceOf(TwentyRateLimitError);
  });
});

describe('contract for TCA-29 / TCA-30 (shape only)', () => {
  it('exports escapeLike, findPeopleByEmails and findRecentlySeenPeople with the promised shapes', async () => {
    const mod = (await loadMatch()) as unknown as Record<string, unknown>;
    expect(typeof mod.escapeLike).toBe('function');
    expect(typeof mod.findPeopleByEmails).toBe('function');
    expect(typeof mod.findRecentlySeenPeople).toBe('function');
    const m = mod as unknown as MatchModule;

    expect(typeof m.escapeLike('x')).toBe('string');

    sdk.query.mockResolvedValue(page([node({ id: 'p', email: 'a@x.com', page: 'u' })]));
    const map = await m.findPeopleByEmails(['a@x.com']);
    expect(map).toBeInstanceOf(Map);
    const [snapshot] = map.get('a@x.com') ?? [];
    const keys = [
      'email',
      'id',
      'posthogLastPage',
      'posthogLastSeenAt',
      'posthogPageviews30d',
      'posthogProfile',
    ];
    expect(Object.keys(snapshot).sort()).toEqual(keys);

    const list = await m.findRecentlySeenPeople(new Date());
    expect(Array.isArray(list)).toBe(true);
    expect(Object.keys(list[0]).sort()).toEqual(keys);
  });
});
