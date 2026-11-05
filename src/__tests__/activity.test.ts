// TCA-28 red-phase tests: getActivity() and readPrimaryEmail() in src/lib/activity.ts, and the
// GET /activity route in src/logic-functions/activity-route.function.ts.
//
// External facts (no DB tables; Twenty Core API and PostHog shapes only):
//  - Person.emails is `Emails` with `primaryEmail`; the one-record query is
//    `person: { __args: { filter: { id: { eq } } }, emails: { primaryEmail: true } }`
//    (lead-scoring-agent src/lib/enrich.ts; genql via `new CoreApiClient()`, D-TCA-ga-api-shapes D2).
//  - PostHogErrorKind and PostHogError(kind, detail): src/lib/posthog-client.ts (D-TCA-22 Error matrix).
//  - latestEventsQuery / parseLatestEvents / profileUrl: src/lib/queries.ts
//    (D-TCA-24-caller-clock-windows: the window is bound from the caller's `now`).
//  - twenty-sdk 2.54.3: defineLogicFunction(...) returns { success, config, errors };
//    config.httpRouteTriggerSettings = { path, httpMethod, isAuthRequired }; the handler gets a
//    LogicFunctionEvent with `queryStringParameters: Record<string, string | undefined>`.
//
// Pinned contract for /implement (TCA-31 consumes it):
//  src/lib/activity.ts exports getActivity(personId, deps?), readPrimaryEmail(personId) and the
//  types ActivityEvent, ActivityResponse. deps = { readSettings, readPrimaryEmail, createClient, now }.
//
// The new modules are loaded at runtime by absolute path so they can be absent in the red phase.
// The type-only import below is erased at runtime; `yarn typecheck` fails until the module exists.
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import application from 'src/application-config';
import * as identifiers from 'src/constants/universal-identifiers';
import type { ActivityEvent, ActivityResponse } from 'src/lib/activity';
import { PostHogError, type PostHogErrorKind } from 'src/lib/posthog-client';
import { latestEventsQuery, profileUrl } from 'src/lib/queries';
import { TwentyRateLimitError } from 'src/lib/twenty-errors';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('twenty-client-sdk/core', () => ({
  CoreApiClient: class {
    query = query;
  },
}));

type Settings = { host: string; projectId: string; apiKey: string };
type RunQuery = (input: { query: string; values?: Record<string, unknown>; name: string }) => Promise<{
  columns: string[];
  results: unknown[][];
  bytesRead: number | null;
}>;
type Deps = {
  readSettings: () => { ok: true; settings: Settings } | { ok: false; problems: unknown[] };
  readPrimaryEmail: (personId: string) => Promise<string | null>;
  createClient: (settings: Settings, options: { timeoutMs: number }) => { runQuery: RunQuery };
  now: () => Date;
};
type Result = { status: string; message?: string; events?: unknown[]; profileUrl?: string | null };
type ActivityModule = {
  getActivity: (personId: string | undefined, deps?: Partial<Deps>) => Promise<Result>;
  readPrimaryEmail: (personId: string) => Promise<string | null>;
};
type RouteHandler = (event: { queryStringParameters: Record<string, string | undefined> }) => Promise<Result>;
type RouteModule = {
  default: {
    success: boolean;
    errors: string[];
    config: {
      universalIdentifier: string;
      timeoutSeconds?: number;
      httpRouteTriggerSettings?: { path: string; httpMethod: string; isAuthRequired: boolean };
      handler: RouteHandler;
    };
  };
};

const loadActivity = async (): Promise<ActivityModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/activity.ts'));
const loadRoute = async (): Promise<RouteModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/logic-functions/activity-route.function.ts'));

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERSON_ID = '3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b';
const KEY = 'phx_SECRET_activity_route_key_5e4d3c2b1a';
const DETAIL_SENTINEL = 'DETAIL_SENTINEL_must_never_reach_the_widget';
const SETTINGS: Settings = { host: 'https://eu.posthog.com', projectId: '777', apiKey: KEY };
const NOW = new Date('2026-11-05T12:00:00.000Z');
const NINETY_DAYS_BEFORE_NOW = '2026-08-07T12:00:00.000Z';

const MESSAGES = {
  missingId: 'Missing person id',
  notConfigured: 'Connect PostHog in Settings > Apps',
  noEmail: 'No email on this person',
  noActivity: 'No PostHog activity for this email',
  rateLimited: 'PostHog is busy, try again in a minute',
  timeout: 'PostHog took too long, try again',
  connection: "PostHog connection failed; an admin should check Settings > Apps",
  generic: 'Could not load PostHog activity',
};

const COLUMNS = ['event', 'url', 'timestamp', 'person_id'];
const rows = (results: unknown[][]) => ({ columns: COLUMNS, results, bytesRead: 1024 });

// Every dep is a spy so each step can assert which later steps never ran.
const makeDeps = (overrides: Partial<Deps> = {}) => {
  const runQuery = vi.fn<RunQuery>(async () => rows([]));
  const deps = {
    readSettings: vi.fn<Deps['readSettings']>(() => ({ ok: true, settings: SETTINGS })),
    readPrimaryEmail: vi.fn<Deps['readPrimaryEmail']>(async () => 'ada@example.com'),
    createClient: vi.fn<Deps['createClient']>(() => ({ runQuery })),
    now: vi.fn<Deps['now']>(() => NOW),
    ...overrides,
  };
  return { deps, runQuery };
};

beforeEach(() => {
  query.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('contract for TCA-31: route and ActivityResponse shape', () => {
  it('exports getActivity, readPrimaryEmail and the response types, and registers GET /activity', async () => {
    const activity = await loadActivity();
    expect(typeof activity.getActivity).toBe('function');
    expect(typeof activity.readPrimaryEmail).toBe('function');

    // Checked by `yarn typecheck`; a no-op at runtime.
    expectTypeOf<ActivityEvent>().toEqualTypeOf<{
      event: string;
      url: string | null;
      timestamp: string;
    }>();
    expectTypeOf<ActivityResponse>().toEqualTypeOf<
      | { status: 'ok'; events: ActivityEvent[]; profileUrl: string | null }
      | {
          status: 'not_configured' | 'no_email' | 'no_activity' | 'rate_limited' | 'timeout' | 'error';
          message: string;
        }
    >();

    const route = (await loadRoute()).default;
    expect(route.errors).toEqual([]);
    expect(route.success).toBe(true);
    expect(route.config.httpRouteTriggerSettings).toEqual({
      path: '/activity',
      httpMethod: 'GET',
      isAuthRequired: true,
    });
    expect(route.config.timeoutSeconds).toBe(15);
    expect(route.config.universalIdentifier).toMatch(UUID_V4);

    const declared = Object.values(identifiers).filter((value) => value === route.config.universalIdentifier);
    expect(declared).toHaveLength(1);
    expect(application.config.universalIdentifier).not.toBe(route.config.universalIdentifier);
  });
});

describe('getActivity: guard steps 1 to 3', () => {
  it.each([undefined, '', 'not-a-uuid', `${PERSON_ID}' OR 1=1`])(
    'step 1: personId %j returns error "Missing person id" and calls nothing else',
    async (personId) => {
      const { getActivity } = await loadActivity();
      const { deps, runQuery } = makeDeps();

      await expect(getActivity(personId, deps)).resolves.toEqual({
        status: 'error',
        message: MESSAGES.missingId,
      });
      expect(deps.readSettings).not.toHaveBeenCalled();
      expect(deps.readPrimaryEmail).not.toHaveBeenCalled();
      expect(deps.createClient).not.toHaveBeenCalled();
      expect(runQuery).not.toHaveBeenCalled();
    },
  );

  it('step 2: settings not ok returns not_configured and makes no email read or PostHog call', async () => {
    const { getActivity } = await loadActivity();
    const { deps, runQuery } = makeDeps({
      readSettings: vi.fn(() => ({ ok: false as const, problems: [{ key: 'POSTHOG_PROJECT_ID' }] })),
    });

    await expect(getActivity(PERSON_ID, deps)).resolves.toEqual({
      status: 'not_configured',
      message: MESSAGES.notConfigured,
    });
    expect(deps.readPrimaryEmail).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it.each([null, '', '   \t '])(
    'step 3: primary email %j returns no_email and makes no PostHog call',
    async (email) => {
      const { getActivity } = await loadActivity();
      const { deps, runQuery } = makeDeps({ readPrimaryEmail: vi.fn(async () => email) });

      await expect(getActivity(PERSON_ID, deps)).resolves.toEqual({
        status: 'no_email',
        message: MESSAGES.noEmail,
      });
      expect(deps.readPrimaryEmail).toHaveBeenCalledWith(PERSON_ID);
      expect(deps.createClient).not.toHaveBeenCalled();
      expect(runQuery).not.toHaveBeenCalled();
    },
  );
});

describe('getActivity: PostHog query steps 4 and 5', () => {
  it('step 4: binds the trimmed lowercase email and a 90-day window, one runQuery, zero rows is no_activity', async () => {
    const { getActivity } = await loadActivity();
    const { deps, runQuery } = makeDeps({
      readPrimaryEmail: vi.fn(async () => '  Ada.Lovelace@Example.COM '),
    });

    await expect(getActivity(PERSON_ID, deps)).resolves.toEqual({
      status: 'no_activity',
      message: MESSAGES.noActivity,
    });

    expect(deps.createClient).toHaveBeenCalledTimes(1);
    expect(deps.createClient).toHaveBeenCalledWith(SETTINGS, { timeoutMs: 7_000 });
    expect(runQuery).toHaveBeenCalledTimes(1);

    const built = latestEventsQuery({ email: 'ada.lovelace@example.com', now: NOW });
    const input = runQuery.mock.calls[0][0];
    expect(input.query).toBe(built.query);
    expect(input.values).toEqual({
      email: 'ada.lovelace@example.com',
      since: NINETY_DAYS_BEFORE_NOW,
      limit: 20,
    });
    expect(typeof input.name).toBe('string');
  });

  it('step 5: returns events newest first without personRef, and profileUrl from the first row', async () => {
    const { getActivity } = await loadActivity();
    const { deps, runQuery } = makeDeps();
    runQuery.mockResolvedValueOnce(
      rows([
        ['$pageview', 'https://example.com/pricing', '2026-11-04T10:00:00Z', 'person-ref-first'],
        ['$autocapture', null, '2026-11-03T09:30:00Z', 'person-ref-second'],
      ]),
    );

    const response = await getActivity(PERSON_ID, deps);

    expect(response).toEqual({
      status: 'ok',
      events: [
        { event: '$pageview', url: 'https://example.com/pricing', timestamp: '2026-11-04T10:00:00.000Z' },
        { event: '$autocapture', url: null, timestamp: '2026-11-03T09:30:00.000Z' },
      ],
      profileUrl: profileUrl(SETTINGS.host, SETTINGS.projectId, 'person-ref-first'),
    });
    expect(response.profileUrl).not.toContain('person-ref-second');
    expect(runQuery).toHaveBeenCalledTimes(1);
  });
});

describe('getActivity: errors (steps 6 and 7), never throws', () => {
  const ADMIN = { status: 'error', message: MESSAGES.connection };
  const GENERIC = { status: 'error', message: MESSAGES.generic };
  const CASES: [PostHogErrorKind, { status: string; message: string }][] = [
    ['rate_limited', { status: 'rate_limited', message: MESSAGES.rateLimited }],
    ['timeout', { status: 'timeout', message: MESSAGES.timeout }],
    ['unauthorized', ADMIN],
    ['missing_scope', ADMIN],
    ['project_not_found', ADMIN],
    ['unreachable', ADMIN],
    ['bad_query', GENERIC],
    ['server_error', GENERIC],
  ];

  it.each(CASES)(
    'step 6: PostHogError kind %s maps to %o with no key or detail in the response',
    async (kind, expected) => {
      const { getActivity } = await loadActivity();
      const { deps, runQuery } = makeDeps();
      runQuery.mockRejectedValueOnce(new PostHogError(kind, `HTTP 4xx: ${DETAIL_SENTINEL} ${KEY}`));

      const response = await getActivity(PERSON_ID, deps);

      expect(response).toEqual(expected);
      expect(runQuery).toHaveBeenCalledTimes(1);
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain(DETAIL_SENTINEL);
      expect(serialized).not.toContain(KEY);
    },
  );

  it('step 7: a non-PostHog throw from runQuery, readPrimaryEmail or parsing returns the generic error', async () => {
    const { getActivity } = await loadActivity();

    const fromRunQuery = makeDeps();
    fromRunQuery.runQuery.mockRejectedValueOnce(new TypeError(`boom ${DETAIL_SENTINEL}`));
    await expect(getActivity(PERSON_ID, fromRunQuery.deps)).resolves.toEqual(GENERIC);

    const fromEmail = makeDeps({
      readPrimaryEmail: vi.fn(async () => {
        throw new Error(`core api down ${DETAIL_SENTINEL}`);
      }),
    });
    await expect(getActivity(PERSON_ID, fromEmail.deps)).resolves.toEqual(GENERIC);
    expect(fromEmail.deps.createClient).not.toHaveBeenCalled();

    // A result missing the person_id column makes parseLatestEvents throw.
    const fromParse = makeDeps();
    fromParse.runQuery.mockResolvedValueOnce({
      columns: ['event', 'url', 'timestamp'],
      results: [['$pageview', null, '2026-11-04T10:00:00Z']],
      bytesRead: null,
    });
    await expect(getActivity(PERSON_ID, fromParse.deps)).resolves.toEqual(GENERIC);
  });

  it('a Twenty throttle while reading the email returns rate_limited naming Twenty', async () => {
    const { getActivity } = await loadActivity();
    const { deps } = makeDeps({
      readPrimaryEmail: vi.fn(async () => {
        throw new TwentyRateLimitError();
      }),
    });

    await expect(getActivity(PERSON_ID, deps)).resolves.toEqual({
      status: 'rate_limited',
      message: 'Twenty is busy, try again in a minute',
    });
    expect(deps.createClient).not.toHaveBeenCalled();
  });
});

describe('readPrimaryEmail and the route handler', () => {
  it('readPrimaryEmail reads emails.primaryEmail for the person id, and null when absent', async () => {
    const { readPrimaryEmail } = await loadActivity();

    query.mockResolvedValueOnce({ person: { emails: { primaryEmail: 'Ada@Example.com' } } });
    await expect(readPrimaryEmail(PERSON_ID)).resolves.toBe('Ada@Example.com');
    expect(query).toHaveBeenCalledTimes(1);
    const selection = query.mock.calls[0][0];
    expect(selection.person.__args.filter.id).toEqual({ eq: PERSON_ID });
    expect(selection.person.emails).toEqual({ primaryEmail: true });

    query.mockResolvedValueOnce({ person: null });
    await expect(readPrimaryEmail(PERSON_ID)).resolves.toBeNull();

    query.mockResolvedValueOnce({ person: { emails: { primaryEmail: null } } });
    await expect(readPrimaryEmail(PERSON_ID)).resolves.toBeNull();
  });

  it('readPrimaryEmail rethrows a throttled Twenty read as TwentyRateLimitError', async () => {
    const { readPrimaryEmail } = await loadActivity();

    query.mockRejectedValueOnce(new Error('Too Many Requests: ThrottlerException: Too Many Requests'));
    await expect(readPrimaryEmail(PERSON_ID)).rejects.toBeInstanceOf(TwentyRateLimitError);
  });

  it('the handler passes queryStringParameters.personId to getActivity with the real deps', async () => {
    const handler = (await loadRoute()).default.config.handler;
    for (const key of ['POSTHOG_HOST', 'POSTHOG_CUSTOM_HOST', 'POSTHOG_PROJECT_ID', 'POSTHOG_PERSONAL_API_KEY']) {
      vi.stubEnv(key, '');
    }

    await expect(handler({ queryStringParameters: {} })).resolves.toEqual({
      status: 'error',
      message: MESSAGES.missingId,
    });
    // A valid id gets past step 1 and the real readSettings reports the empty env.
    await expect(handler({ queryStringParameters: { personId: PERSON_ID } })).resolves.toEqual({
      status: 'not_configured',
      message: MESSAGES.notConfigured,
    });
    expect(query).not.toHaveBeenCalled();
  });
});
