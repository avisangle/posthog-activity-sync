// TCA-27 red-phase tests: writeActivity and clearActivity in src/lib/write-activity.ts,
// isTwentyRateLimit / TwentyRateLimitError in src/lib/twenty-errors.ts, and the decision records.
//
// External facts (no DB tables; Twenty GraphQL through CoreApiClient, genql, created in-function):
//  - Write method (D-TCA-22): createPeople(data, upsert: true), batches of 200, only ids read in the
//    same run (the PersonSnapshot brand). `null` on a LINKS field is ignored, so a LINKS clear is
//    { primaryLinkUrl: '', primaryLinkLabel: '', secondaryLinks: [] }; a LINKS composite is replaced
//    whole; DATE_TIME and NUMBER clear with null.
//  - Payload (D-TCA-27-shared-write-lease, written in this story's PR): all four fields per changed
//    record. LINKS labels: '' for posthogLastPage, 'PostHog' for posthogProfile.
//  - A non-2xx Twenty response throws Error(`${statusText}: ${rawBody}`) (twenty-client-sdk 2.54.3);
//    NestJS's throttler body is `ThrottlerException: Too Many Requests`.
//  - D-TCA-22 Status follows D-TCA-20-partial-supersession (merged after the issue text was
//    written): `Accepted; partly superseded by <ID> (<what>)`, D-TCA-24 first, so queries.test.ts
//    keeps passing. The issue's literal "TCA-24 Impact line superseded by ..." form is not used.
//
// The `import type` lines below make this file fail `yarn typecheck` until the modules exist; that
// is deliberate: the brand fence needs the real signatures. Runtime loads are by absolute path.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivityValues, PersonSnapshot } from '../lib/match-people';
import type * as ErrorsModule from '../lib/twenty-errors';
import type * as WriterModule from '../lib/write-activity';

const sdk = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));
vi.mock('twenty-client-sdk/core', () => ({
  CoreApiClient: class {
    query = sdk.query;
    mutation = sdk.mutation;
  },
}));

const loadWriter = async (): Promise<typeof WriterModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/write-activity.ts'));
const loadErrors = async (): Promise<typeof ErrorsModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/twenty-errors.ts'));

const PAGE = 'https://acme.com/app';
const PROFILE = 'https://us.posthog.com/project/1/persons/u-1';
const EMPTY_LINK = { primaryLinkUrl: '', primaryLinkLabel: '', secondaryLinks: [] };
const pageLink = (url: string) => ({ primaryLinkUrl: url, primaryLinkLabel: '', secondaryLinks: [] });
const profileLink = (url: string) => ({
  primaryLinkUrl: url,
  primaryLinkLabel: 'PostHog',
  secondaryLinks: [],
});

// Fixtures cast to the brand, as the issue allows for tests.
const snap = (id: string, values: Partial<ActivityValues> = {}): PersonSnapshot =>
  ({
    id,
    email: `${id}@x.com`,
    posthogLastSeenAt: '2026-11-03T23:10:00Z',
    posthogPageviews30d: 5,
    posthogLastPage: PAGE,
    posthogProfile: PROFILE,
    ...values,
  }) as PersonSnapshot;

type CreatePeopleArgs = { data: Record<string, unknown>[]; upsert: boolean };
const sent = (): CreatePeopleArgs[] =>
  sdk.mutation.mock.calls.map(([m]) => {
    expect(Object.keys(m)).toEqual(['createPeople']);
    return m.createPeople.__args;
  });
const records = () => sent().flatMap((a) => a.data);

beforeEach(() => {
  sdk.query.mockReset();
  sdk.mutation.mockReset();
  sdk.mutation.mockImplementation(async (m: { createPeople: { __args: CreatePeopleArgs } }) => ({
    createPeople: m.createPeople.__args.data.map((r) => ({ id: r.id })),
  }));
});

describe('writeActivity: diff', () => {
  it('makes no request when nothing differs, ignoring absent and undefined keys', async () => {
    const { writeActivity } = await loadWriter();

    const result = await writeActivity([
      { snapshot: snap('a'), next: {} },
      { snapshot: snap('b'), next: { posthogLastSeenAt: undefined, posthogProfile: undefined } },
      {
        snapshot: snap('c'),
        next: { posthogPageviews30d: 5, posthogLastPage: PAGE, posthogProfile: PROFILE },
      },
      { snapshot: snap('d', { posthogLastPage: null }), next: { posthogLastPage: '' } },
    ]);

    expect(result).toEqual({ written: 0, unchanged: 4 });
    expect(sdk.mutation).not.toHaveBeenCalled();
  });

  it('compares dates by instant: two ISO forms of one instant are unchanged, 1 ms later is not', async () => {
    const { writeActivity } = await loadWriter();

    const result = await writeActivity([
      { snapshot: snap('same'), next: { posthogLastSeenAt: '2026-11-03T23:10:00.000Z' } },
      { snapshot: snap('later'), next: { posthogLastSeenAt: '2026-11-03T23:10:00.001Z' } },
    ]);

    expect(result).toEqual({ written: 1, unchanged: 1 });
    expect(records().map((r) => r.id)).toEqual(['later']);
    expect(records()[0].posthogLastSeenAt).toBe('2026-11-03T23:10:00.001Z');
  });

  it('treats 0 and null as different values', async () => {
    const { writeActivity } = await loadWriter();

    const result = await writeActivity([
      { snapshot: snap('n', { posthogPageviews30d: null }), next: { posthogPageviews30d: 0 } },
      { snapshot: snap('z', { posthogPageviews30d: 0 }), next: { posthogPageviews30d: null } },
    ]);

    expect(result).toEqual({ written: 2, unchanged: 0 });
    expect(records().map((r) => [r.id, r.posthogPageviews30d])).toEqual([
      ['n', 0],
      ['z', null],
    ]);
  });
});

describe('writeActivity: payload', () => {
  it('writes all four fields when only posthogPageviews30d differs, the rest from the snapshot', async () => {
    const { writeActivity } = await loadWriter();

    await writeActivity([{ snapshot: snap('p-1'), next: { posthogPageviews30d: 9 } }]);

    expect(records()).toEqual([
      {
        id: 'p-1',
        posthogLastSeenAt: '2026-11-03T23:10:00Z',
        posthogPageviews30d: 9,
        posthogLastPage: pageLink(PAGE),
        posthogProfile: profileLink(PROFILE),
      },
    ]);
  });

  it("labels the last page '' and the profile 'PostHog'", async () => {
    const { writeActivity } = await loadWriter();

    await writeActivity([
      {
        snapshot: snap('p-1', { posthogLastPage: null, posthogProfile: null }),
        next: { posthogLastPage: 'https://acme.com/new', posthogProfile: 'https://ph/new' },
      },
    ]);

    const [record] = records();
    expect(record.posthogLastPage).toEqual(pageLink('https://acme.com/new'));
    expect(record.posthogProfile).toEqual(profileLink('https://ph/new'));
  });

  it('clears a populated person with null scalars and empty LINKS composites, never null LINKS', async () => {
    const { writeActivity, clearActivity } = await loadWriter();
    expect(clearActivity()).toEqual({
      posthogLastSeenAt: null,
      posthogLastPage: null,
      posthogPageviews30d: null,
      posthogProfile: null,
    });

    const result = await writeActivity([{ snapshot: snap('p-1'), next: clearActivity() }]);

    expect(result).toEqual({ written: 1, unchanged: 0 });
    expect(records()).toEqual([
      {
        id: 'p-1',
        posthogLastSeenAt: null,
        posthogPageviews30d: null,
        posthogLastPage: EMPTY_LINK,
        posthogProfile: EMPTY_LINK,
      },
    ]);
  });

  it('leaves an already-cleared person alone, including one read back with LINKS as empty strings', async () => {
    const { writeActivity, clearActivity } = await loadWriter();
    const cleared = {
      posthogLastSeenAt: null,
      posthogPageviews30d: null,
      posthogLastPage: null,
      posthogProfile: null,
    };

    const result = await writeActivity([
      { snapshot: snap('read-null', cleared), next: clearActivity() },
      {
        snapshot: snap('read-empty', { ...cleared, posthogLastPage: '', posthogProfile: '' }),
        next: clearActivity(),
      },
    ]);

    expect(result).toEqual({ written: 0, unchanged: 2 });
    expect(sdk.mutation).not.toHaveBeenCalled();
  });

  it('sends 201 changed records as two createPeople upserts (200 + 1) carrying exactly the changed ids', async () => {
    const { writeActivity } = await loadWriter();
    const changed = Array.from({ length: 201 }, (_, i) => ({
      snapshot: snap(`c-${i}`),
      next: { posthogPageviews30d: 100 + i },
    }));
    const unchanged = [
      { snapshot: snap('u-1'), next: { posthogPageviews30d: 5 } },
      { snapshot: snap('u-2'), next: {} },
    ];

    const result = await writeActivity([unchanged[0], ...changed, unchanged[1]]);

    expect(result).toEqual({ written: 201, unchanged: 2 });
    expect(sdk.mutation).toHaveBeenCalledTimes(2);
    expect(sent().map((a) => [a.data.length, a.upsert])).toEqual([
      [200, true],
      [1, true],
    ]);
    expect(records().map((r) => r.id).sort()).toEqual(changed.map((c) => c.snapshot.id).sort());
  });

  it('accepts only snapshots from a same-run read (typecheck fence)', async () => {
    const { writeActivity } = await loadWriter();

    const result = await writeActivity([
      {
        // @ts-expect-error an unbranded literal is not a PersonSnapshot; removing the brand fails typecheck
        snapshot: {
          id: 'x',
          email: null,
          posthogLastSeenAt: null,
          posthogLastPage: null,
          posthogPageviews30d: null,
          posthogProfile: null,
        },
        next: {},
      },
    ]);

    expect(result).toEqual({ written: 0, unchanged: 1 });
  });
});

describe('rate limit', () => {
  it('isTwentyRateLimit matches a "too many requests" Error message only', async () => {
    const { isTwentyRateLimit } = await loadErrors();

    expect(isTwentyRateLimit(new Error('Too Many Requests: {"statusCode":429}'))).toBe(true);
    expect(isTwentyRateLimit(new Error('ThrottlerException: Too Many Requests'))).toBe(true);
    expect(isTwentyRateLimit(new Error('too many requests'))).toBe(true);
    expect(isTwentyRateLimit(new Error('Internal Server Error: boom'))).toBe(false);
    expect(isTwentyRateLimit('Too Many Requests')).toBe(false);
    expect(isTwentyRateLimit({ message: 'Too Many Requests' })).toBe(false);
    expect(isTwentyRateLimit(undefined)).toBe(false);
  });

  it('writeActivity rethrows a throttled write as TwentyRateLimitError and any other error unchanged', async () => {
    const { writeActivity } = await loadWriter();
    const { TwentyRateLimitError } = await loadErrors();
    const change = [{ snapshot: snap('p-1'), next: { posthogPageviews30d: 1 } }];

    sdk.mutation.mockRejectedValueOnce(new Error('Too Many Requests: {"statusCode":429}'));
    await expect(writeActivity(change)).rejects.toBeInstanceOf(TwentyRateLimitError);

    const boom = new Error('Internal Server Error: boom');
    sdk.mutation.mockRejectedValueOnce(boom);
    const rejection = writeActivity(change);
    await expect(rejection).rejects.toBe(boom);
    await expect(rejection).rejects.not.toBeInstanceOf(TwentyRateLimitError);
  });
});

describe('decision records', () => {
  const read = (name: string) =>
    readFileSync(resolve(process.cwd(), 'docs/decisions', name), 'utf8');
  const status = (doc: string) => doc.match(/^\*\*Status:\*\* (.+)$/m)?.[1] ?? '';

  it('records the three TCA-27 decisions and marks D-TCA-22 partly superseded for the payload', () => {
    for (const name of [
      'D-TCA-27-diff-only-batched-writes.md',
      'D-TCA-27-job-scheduling.md',
      'D-TCA-27-shared-write-lease.md',
    ]) {
      expect(status(read(name))).toMatch(/^Accepted/);
    }

    const lease = read('D-TCA-27-shared-write-lease.md');
    expect(status(lease)).toMatch(/^Accepted; partly supersedes D-TCA-22-posthog-api-shapes \(.+\)$/);
    expect(lease).toContain('ACTIVITY_WRITE_LEASE');

    const d22 = read('D-TCA-22-posthog-api-shapes.md');
    const d22Status = status(d22);
    expect(d22Status).toMatch(/^Accepted; partly superseded by D-TCA-24-caller-clock-windows \(/);
    expect(d22Status).toMatch(/partly superseded by D-TCA-27-shared-write-lease \(.+\)/);

    const decision = d22.match(/^\*\*Decision:\*\*[\s\S]*?(?=^\*\*Why:\*\*)/m)?.[0] ?? '';
    expect(decision).toContain('{ id, <changed fields> }');
    expect(decision).toContain('superseded by D-TCA-27-shared-write-lease');

    const impact = d22.match(/^- \*\*TCA-27 \(writer\):\*\*[\s\S]*?(?=^## Evidence)/m)?.[0] ?? '';
    expect(impact).toContain("{ primaryLinkUrl: '', primaryLinkLabel: '', secondaryLinks: [] }");
    expect(impact).toContain('D-TCA-27-shared-write-lease');
    expect(impact).toContain('ACTIVITY_WRITE_LEASE');
  });
});

describe('contract for TCA-29 / TCA-30 (shape only)', () => {
  it('exports writeActivity, clearActivity, TwentyRateLimitError and isTwentyRateLimit', async () => {
    const writer = (await loadWriter()) as unknown as Record<string, unknown>;
    const errors = (await loadErrors()) as unknown as Record<string, unknown>;
    expect(typeof writer.writeActivity).toBe('function');
    expect(typeof writer.clearActivity).toBe('function');
    expect(typeof errors.TwentyRateLimitError).toBe('function');
    expect(typeof errors.isTwentyRateLimit).toBe('function');

    const { writeActivity, clearActivity } = writer as unknown as typeof WriterModule;
    const { TwentyRateLimitError, isTwentyRateLimit } = errors as unknown as typeof ErrorsModule;

    const result = await writeActivity([]);
    expect(Object.keys(result).sort()).toEqual(['unchanged', 'written']);
    expect(typeof result.written).toBe('number');
    expect(typeof result.unchanged).toBe('number');
    expect(Object.keys(clearActivity()).sort()).toEqual([
      'posthogLastPage',
      'posthogLastSeenAt',
      'posthogPageviews30d',
      'posthogProfile',
    ]);
    expect(new (TwentyRateLimitError as unknown as new (m?: string) => Error)('x')).toBeInstanceOf(
      Error,
    );
    expect(typeof isTwentyRateLimit(new Error('x'))).toBe('boolean');
  });
});
