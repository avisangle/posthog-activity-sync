// TCA-23 red-phase tests: createPostHogClient() in src/lib/posthog-client.ts.
//
// External facts, all from docs/decisions/D-TCA-22-posthog-api-shapes.md (it wins over the issue text):
//  - POST {host}/api/projects/{projectId}/query/, Authorization: Bearer <key>, Content-Type: application/json.
//  - Body { query: { kind: 'HogQLQuery', query, values }, refresh: 'force_blocking', name }.
//    'force_blocking', not the issue's 'blocking': 'blocking' served stale cached results.
//    `name` is the issue's field; the record is silent on it, so it is kept.
//  - 200 body: columns (string[]), types, results (row arrays), hasMore, is_cached, error.
//    X-PostHog-Query-Bytes-Read is present only on computed (non-cached) responses.
//  - Error matrix (PostHog error bodies are { type, code, detail, attr }):
//      401 | 403 with code authentication_failed / not_authenticated -> unauthorized
//      403 permission_denied, detail starts "API key missing required scope" -> missing_scope
//      403 permission_denied, "does not have access to the requested project" | 404 -> project_not_found
//      429 (any code) -> rate_limited, with Retry-After; code api_queries_budget_exceeded -> budgetExceeded
//      504 -> timeout; 400 -> bad_query; fetch rejection -> unreachable; other 5xx -> server_error
//  - No getProject(): GET /api/projects/{id}/ returns 403 for every query:read-only key.
//
// Pinned contract for /implement:
//  createPostHogClient(settings, { fetch?, timeoutMs? }).runQuery({ query, values, name })
//    -> Promise<{ columns: string[]; results: unknown[][]; bytesRead: number | null }>
//  rejects with PostHogError (extends Error): { kind, detail, retryAfterSeconds: number | null, budgetExceeded: boolean }
//  The client's own abort timeout also rejects with kind 'timeout'.
import { resolve } from 'node:path';
import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PostHogError, RunQueryInput } from 'src/lib/posthog-client';
import type { PostHogSettings } from 'src/lib/settings';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ClientModule = typeof import('src/lib/posthog-client');
type SettingsModule = typeof import('src/lib/settings');

const loadClient = async (): Promise<ClientModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/posthog-client.ts'));
const loadSettings = async (): Promise<SettingsModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/settings.ts'));

const KEY = 'phx_SECRET_client_test_key_9f8e7d6c5b4a';
const SETTINGS: PostHogSettings = {
  host: 'https://us.posthog.com',
  projectId: '12345',
  apiKey: KEY,
};
const QUERY =
  'SELECT lower(p.properties.email) AS email FROM persons AS p WHERE lower(p.properties.email) IN {emails} LIMIT {limit}';
const VALUES = {
  emails: ['chesky@airbnb.com', "x') OR 1=1 --@example.com"],
  limit: 500,
  since: '2026-10-05T00:00:00Z',
};
const INPUT: RunQueryInput = { query: QUERY, values: VALUES, name: 'pageviewCounts' };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const phError = (status: number, type: string, code: string, detail: string, headers = {}) =>
  json(status, { type, code, detail, attr: null }, headers);

const OK_BODY = {
  columns: ['email', 'pageviews_30d'],
  types: [
    ['email', 'Nullable(String)'],
    ['pageviews_30d', 'UInt64'],
  ],
  results: [
    ['chesky@airbnb.com', 5],
    ['zhao@notion.com', 0],
  ],
  hasMore: false,
  is_cached: false,
  error: null,
};

const fakeFetch = (respond: () => Response | Promise<Response>) =>
  vi.fn<FetchLike>(async () => respond());

// Resolves whether the client calls fetch(url, init) or fetch(new Request(...)).
const sentRequest = (fetchMock: ReturnType<typeof fakeFetch>) => {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [input, init] = fetchMock.mock.calls[0];
  return new Request(input, init);
};

// Never settles until the client aborts the request; then rejects the way real fetch does.
const hangingFetch = (rejection?: (signal: AbortSignal) => unknown) =>
  vi.fn<FetchLike>(
    (input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        signal?.addEventListener('abort', () =>
          reject(rejection ? rejection(signal) : signal.reason),
        );
      }),
  );

const rejectionOf = async (promise: Promise<unknown>): Promise<PostHogError> => {
  try {
    await promise;
  } catch (error) {
    return error as PostHogError;
  }
  throw new Error('expected runQuery to reject');
};

// `echo` is spliced into whatever the server or runtime says, so the redaction test can make
// PostHog (or fetch) repeat the key back and check the client never passes it on.
type KindCase = {
  name: string;
  kind: string;
  respond: (echo: string) => Response | Promise<Response>;
  retryAfterSeconds?: number | null;
  budgetExceeded?: boolean;
};
const KIND_CASES: KindCase[] = [
  {
    name: '403 authentication_failed (bad key or wrong region)',
    kind: 'unauthorized',
    respond: (echo) =>
      phError(
        403,
        'authentication_error',
        'authentication_failed',
        `Personal API key found in request Authorization header is invalid.${echo}`,
      ),
  },
  {
    name: '403 not_authenticated',
    kind: 'unauthorized',
    respond: (echo) =>
      phError(
        403,
        'authentication_error',
        'not_authenticated',
        `Authentication credentials were not provided.${echo}`,
      ),
  },
  {
    name: '401 not_authenticated',
    kind: 'unauthorized',
    respond: (echo) =>
      phError(401, 'authentication_error', 'not_authenticated', `Unauthorized.${echo}`),
  },
  {
    name: '403 permission_denied, missing scope',
    kind: 'missing_scope',
    respond: (echo) =>
      phError(
        403,
        'authentication_error',
        'permission_denied',
        `API key missing required scope 'query:read'${echo}`,
      ),
  },
  {
    name: '403 permission_denied, no access to project',
    kind: 'project_not_found',
    respond: (echo) =>
      phError(
        403,
        'authentication_error',
        'permission_denied',
        `API key does not have access to the requested project: ID 1.${echo}`,
      ),
  },
  {
    name: '404 not_found',
    kind: 'project_not_found',
    respond: (echo) => phError(404, 'invalid_request', 'not_found', `Project not found.${echo}`),
  },
  {
    name: '429 throttled',
    kind: 'rate_limited',
    retryAfterSeconds: 30,
    budgetExceeded: false,
    respond: (echo) =>
      phError(429, 'throttled_error', 'throttled', `Request was throttled.${echo}`, {
        'Retry-After': '30',
      }),
  },
  {
    name: '429 api_queries_budget_exceeded',
    kind: 'rate_limited',
    retryAfterSeconds: 3600,
    budgetExceeded: true,
    respond: (echo) =>
      phError(
        429,
        'throttled_error',
        'api_queries_budget_exceeded',
        `Query read budget exceeded.${echo}`,
        { 'Retry-After': '3600' },
      ),
  },
  {
    name: '504 max execution time',
    kind: 'timeout',
    respond: (echo) =>
      phError(
        504,
        'server_error',
        'error',
        `Query has hit the max execution time before completing.${echo}`,
      ),
  },
  {
    name: '400 hogql_syntax_error',
    kind: 'bad_query',
    respond: (echo) =>
      phError(400, 'validation_error', 'hogql_syntax_error', `Syntax error at line 1.${echo}`),
  },
  {
    name: 'fetch rejects (DNS failure)',
    kind: 'unreachable',
    respond: (echo) => Promise.reject(new TypeError(`fetch failed${echo}`)),
  },
  {
    name: '500 JSON body',
    kind: 'server_error',
    respond: (echo) => phError(500, 'server_error', 'error', `A server error occurred.${echo}`),
  },
  {
    name: '502 non-JSON body from a proxy',
    kind: 'server_error',
    respond: (echo) =>
      new Response(`<html>Bad Gateway${echo}</html>`, {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
  },
];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createPostHogClient().runQuery', () => {
  it('POSTs the exact query request, passing values through unchanged', async () => {
    const { createPostHogClient } = await loadClient();
    const fetchMock = fakeFetch(() => json(200, OK_BODY));

    await createPostHogClient(SETTINGS, { fetch: fetchMock }).runQuery(INPUT);

    const request = sentRequest(fetchMock);
    expect(request.url).toBe('https://us.posthog.com/api/projects/12345/query/');
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(await request.json()).toEqual({
      query: { kind: 'HogQLQuery', query: QUERY, values: VALUES },
      refresh: 'force_blocking',
      name: 'pageviewCounts',
    });
  });

  it('returns columns, results and bytesRead from the header, or null when the header is absent', async () => {
    const { createPostHogClient } = await loadClient();

    const computed = await createPostHogClient(SETTINGS, {
      fetch: fakeFetch(() => json(200, OK_BODY, { 'X-PostHog-Query-Bytes-Read': '1039758' })),
    }).runQuery(INPUT);
    expect(computed).toMatchObject({
      columns: OK_BODY.columns,
      results: OK_BODY.results,
      bytesRead: 1039758,
    });

    const cached = await createPostHogClient(SETTINGS, {
      fetch: fakeFetch(() => json(200, { ...OK_BODY, is_cached: true })),
    }).runQuery(INPUT);
    expect(cached.bytesRead).toBeNull();
  });

  it.each(KIND_CASES)('maps $name to kind $kind', async (row) => {
    const { createPostHogClient, PostHogError } = await loadClient();

    const error = await rejectionOf(
      createPostHogClient(SETTINGS, { fetch: fakeFetch(() => row.respond('')) }).runQuery(INPUT),
    );

    expect(error).toBeInstanceOf(PostHogError);
    expect(error.kind).toBe(row.kind);
    expect(error.retryAfterSeconds).toBe(row.retryAfterSeconds ?? null);
    expect(error.budgetExceeded).toBe(row.budgetExceeded ?? false);
  });

  it('never treats a 403 permission_denied as missing scope by status alone', async () => {
    const { createPostHogClient } = await loadClient();

    const error = await rejectionOf(
      createPostHogClient(SETTINGS, {
        fetch: fakeFetch(() =>
          phError(403, 'authentication_error', 'permission_denied', 'Organization is suspended.'),
        ),
      }).runQuery(INPUT),
    );

    expect(error.kind).not.toBe('missing_scope');
    expect(error.kind).not.toBe('project_not_found');
  });

  it.each([
    ['delta seconds', '120', 120],
    ['zero', '0', 0],
    ['an HTTP date 60 s ahead', 'Wed, 04 Nov 2026 12:01:00 GMT', 60],
    ['missing', undefined, null],
    ['unparseable', 'soon', null],
  ])('parses Retry-After given as %s', async (_case, header, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    const { createPostHogClient } = await loadClient();
    const headers: Record<string, string> = header === undefined ? {} : { 'Retry-After': header };

    const error = await rejectionOf(
      createPostHogClient(SETTINGS, {
        fetch: fakeFetch(() => phError(429, 'throttled_error', 'throttled', 'Throttled.', headers)),
      }).runQuery(INPUT),
    );

    expect(error.kind).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(expected);
  });

  it('aborts the request after timeoutMs and rejects with kind timeout', async () => {
    const { createPostHogClient, PostHogError } = await loadClient();
    const fetchMock = hangingFetch();

    const error = await rejectionOf(
      createPostHogClient(SETTINGS, { fetch: fetchMock, timeoutMs: 20 }).runQuery(INPUT),
    );

    expect(error).toBeInstanceOf(PostHogError);
    expect(error.kind).toBe('timeout');
    expect(sentRequest(fetchMock).signal.aborted).toBe(true);
  }, 2_000);

  it('never puts the API key in an error message, detail, or anything logged, for every kind', async () => {
    const { createPostHogClient } = await loadClient();
    const echo = ` (Authorization: Bearer ${KEY}; key=${KEY})`;
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const scenarios = [
      ...KIND_CASES.map((row) => ({
        name: row.name,
        run: () =>
          createPostHogClient(SETTINGS, { fetch: fakeFetch(() => row.respond(echo)) }).runQuery(
            INPUT,
          ),
      })),
      {
        name: 'client abort timeout',
        run: () =>
          createPostHogClient(SETTINGS, {
            fetch: hangingFetch(() => new DOMException(`aborted${echo}`, 'TimeoutError')),
            timeoutMs: 20,
          }).runQuery(INPUT),
      },
    ];

    for (const scenario of scenarios) {
      const error = await rejectionOf(scenario.run());
      const surfaces = [
        error.message,
        String(error.detail),
        String(error),
        JSON.stringify(error),
        inspect(error, { depth: 10 }),
      ];
      for (const surface of surfaces) expect(surface, scenario.name).not.toContain(KEY);
    }
    for (const spy of logged) {
      expect(inspect(spy.mock.calls, { depth: 10 })).not.toContain(KEY);
    }
  });
});

describe('TCA-23 contract for TCA-26, TCA-28, TCA-29 and TCA-30', () => {
  it('exports readSettings(), createPostHogClient(settings, { fetch }) and PostHogError with kind, retryAfterSeconds, budgetExceeded', async () => {
    const { readSettings } = await loadSettings();
    const { createPostHogClient, PostHogError } = await loadClient();
    expect(typeof readSettings).toBe('function');
    expect(typeof createPostHogClient).toBe('function');
    expect(typeof PostHogError).toBe('function');

    const read = readSettings({
      POSTHOG_HOST: 'https://us.posthog.com',
      POSTHOG_PROJECT_ID: '12345',
      POSTHOG_PERSONAL_API_KEY: KEY,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Object.keys(read.settings).sort()).toEqual(['apiKey', 'host', 'projectId']);

    const client = createPostHogClient(read.settings, { fetch: fakeFetch(() => json(200, OK_BODY)) });
    expect(typeof client.runQuery).toBe('function');
    const result = await client.runQuery(INPUT);
    expect(Array.isArray(result.columns)).toBe(true);
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.bytesRead === null || typeof result.bytesRead === 'number').toBe(true);

    const error = await rejectionOf(
      createPostHogClient(read.settings, {
        fetch: fakeFetch(() => phError(429, 'throttled_error', 'throttled', 'Throttled.')),
      }).runQuery(INPUT),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PostHogError);
    expect(typeof error.kind).toBe('string');
    expect(error.retryAfterSeconds === null || typeof error.retryAfterSeconds === 'number').toBe(
      true,
    );
    expect(typeof error.budgetExceeded).toBe('boolean');
  });
});
