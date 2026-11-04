// TCA-26 red-phase tests: checkHealth() in src/lib/health.ts and the src/health-check.ts entity.
//
// External facts (no DB tables or new endpoints; everything below already exists on main):
//  - readSettings(): SettingsResult = { ok: true, settings } | { ok: false, problems: { key, reason }[] },
//    problems in order host (POSTHOG_HOST or POSTHOG_CUSTOM_HOST), POSTHOG_PROJECT_ID,
//    POSTHOG_PERSONAL_API_KEY (src/lib/settings.ts, TCA-23).
//  - createPostHogClient(settings, { timeoutMs? }).runQuery({ query, values, name }) -> QueryResult,
//    rejects with PostHogError(kind, detail, { retryAfterSeconds }) (src/lib/posthog-client.ts, TCA-23).
//  - healthProbeQuery() / parseHealthProbe() (src/lib/queries.ts, TCA-24); column persons_with_email.
//  - Only the probe query, no GET /api/projects/{id}/; a wrong-region key surfaces as `unauthorized`,
//    so that message names the host setting (D-TCA-22-posthog-api-shapes, TCA-26 Impact).
//  - twenty-sdk 2.54.3 defineHealthCheck({ universalIdentifier, name, timeoutSeconds, handler }),
//    handler: () => { status: 'OK' } | { status, title, description?, action? }.
//
// Pinned contract for /implement:
//  src/lib/health.ts exports checkHealth(deps?: HealthDeps): Promise<HealthResult>, PROBE_TIMEOUT_MS = 12_000,
//    types HealthResult and HealthDeps = { readSettings, createClient(settings) => { runQuery } }.
//  src/health-check.ts default-exports defineHealthCheck({ universalIdentifier:
//    HEALTH_CHECK_UNIVERSAL_IDENTIFIER, name: 'posthog-health-check', timeoutSeconds: 15, handler }).
//  HEALTH_CHECK_UNIVERSAL_IDENTIFIER lives in src/constants/universal-identifiers.ts.
//
// Implementation modules are loaded at runtime by absolute path so this file compiles before they exist.
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import application from 'src/application-config';
import * as ids from 'src/constants/universal-identifiers';
import { PostHogError, type PostHogErrorKind, type QueryResult, type RunQueryInput } from 'src/lib/posthog-client';
import { healthProbeQuery } from 'src/lib/queries';
import type { PostHogSettings, SettingsResult } from 'src/lib/settings';

const { createPostHogClientSpy, defaultRunQuerySpy } = vi.hoisted(() => {
  const defaultRunQuerySpy = vi.fn();
  return {
    defaultRunQuerySpy,
    createPostHogClientSpy: vi.fn(() => ({ runQuery: defaultRunQuerySpy })),
  };
});

// Keeps the real PostHogError so `instanceof` in health.ts sees the same class as the fakes.
vi.mock('src/lib/posthog-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/lib/posthog-client')>()),
  createPostHogClient: createPostHogClientSpy,
}));

type HealthResult =
  | { status: 'OK' }
  | { status: 'WARNING' | 'ERROR'; title: string; description: string };
type HealthDeps = {
  readSettings: () => SettingsResult;
  createClient: (settings: PostHogSettings) => {
    runQuery: (input: RunQueryInput) => Promise<QueryResult>;
  };
};
type HealthModule = {
  checkHealth: (deps?: HealthDeps) => Promise<HealthResult>;
  PROBE_TIMEOUT_MS: number;
};
type HealthCheckEntity = {
  success: boolean;
  errors: unknown[];
  config: {
    universalIdentifier: string;
    name?: string;
    timeoutSeconds?: number;
    handler: () => unknown;
  };
};

const load = async <T>(relPath: string): Promise<T> =>
  (await import(/* @vite-ignore */ resolve(process.cwd(), relPath))) as T;
const loadHealth = () => load<HealthModule>('src/lib/health.ts');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = 'phx_secret_TEST';
const SETTINGS: PostHogSettings = {
  host: 'https://eu.posthog.com',
  projectId: '98765',
  apiKey: SECRET,
};

// Labels come from application-config so a renamed setting cannot leave the check naming the old one.
const variables = application.config.applicationVariables ?? {};
const label = (key: string): string => {
  const value = (variables as Record<string, { label?: string }>)[key]?.label;
  if (!value) throw new Error(`No label for ${key} in application-config`);
  return value;
};

const probeResult = (count: number): QueryResult => ({
  columns: ['persons_with_email'],
  results: [[count]],
  bytesRead: null,
});

const fakeDeps = (probe: () => Promise<QueryResult>, settings: SettingsResult = { ok: true, settings: SETTINGS }) => {
  const runQuery = vi.fn((_input: RunQueryInput) => probe());
  const createClient = vi.fn((_settings: PostHogSettings) => ({ runQuery }));
  const readSettings = vi.fn(() => settings);
  return { deps: { readSettings, createClient } satisfies HealthDeps, runQuery, createClient, readSettings };
};

const expectBanner = (
  result: HealthResult,
  status: 'WARNING' | 'ERROR',
  title: string,
  fragments: string[] = [],
) => {
  expect(result.status).toBe(status);
  // Exactly status, title, description: no `action` field.
  expect(Object.keys(result).sort()).toEqual(['description', 'status', 'title']);
  const banner = result as Extract<HealthResult, { title: string }>;
  expect(banner.title).toBe(title);
  expect(typeof banner.description).toBe('string');
  for (const fragment of fragments) expect(banner.description).toContain(fragment);
};

const expectSingleProbe = (
  createClient: ReturnType<typeof fakeDeps>['createClient'],
  runQuery: ReturnType<typeof fakeDeps>['runQuery'],
) => {
  expect(createClient).toHaveBeenCalledTimes(1);
  expect(createClient).toHaveBeenCalledWith(SETTINGS);
  expect(runQuery).toHaveBeenCalledTimes(1);
  expect(runQuery).toHaveBeenCalledWith({
    query: healthProbeQuery().query,
    values: healthProbeQuery().values,
    name: 'health_check',
  });
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('checkHealth: row 1, settings not usable', () => {
  it.each([
    ['POSTHOG_HOST', 'The PostHog host must start with https://.'],
    ['POSTHOG_CUSTOM_HOST', 'Enter the PostHog host.'],
    ['POSTHOG_PROJECT_ID', 'Enter the PostHog project ID.'],
    ['POSTHOG_PERSONAL_API_KEY', 'Enter a PostHog personal API key with the query:read scope.'],
  ])('ERROR naming %s and its reason, without calling PostHog', async (key, reason) => {
    const { checkHealth } = await loadHealth();
    const { deps, createClient } = fakeDeps(() => Promise.resolve(probeResult(1)), {
      ok: false,
      problems: [{ key, reason }],
    });

    const result = await checkHealth(deps);

    expectBanner(result, 'ERROR', `Check the ${label(key)}`, [`${label(key)}: ${reason}`]);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('with several problems, the title names the first and the description names all', async () => {
    const { checkHealth } = await loadHealth();
    const problems = [
      { key: 'POSTHOG_CUSTOM_HOST', reason: 'Enter the PostHog host.' },
      { key: 'POSTHOG_PROJECT_ID', reason: 'Enter the PostHog project ID.' },
      { key: 'POSTHOG_PERSONAL_API_KEY', reason: 'Enter a PostHog personal API key.' },
    ];
    const { deps, createClient } = fakeDeps(() => Promise.resolve(probeResult(1)), {
      ok: false,
      problems,
    });

    const result = await checkHealth(deps);

    expectBanner(
      result,
      'ERROR',
      `Check the ${label('POSTHOG_CUSTOM_HOST')}`,
      problems.map((p) => `${label(p.key)}: ${p.reason}`),
    );
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('checkHealth: rows 2 and 3, probe succeeds', () => {
  it.each([1, 42])('row 2: exactly { status: OK } when %i persons have an email', async (count) => {
    const { checkHealth } = await loadHealth();
    const { deps, createClient, runQuery } = fakeDeps(() => Promise.resolve(probeResult(count)));

    const result = await checkHealth(deps);

    expect(result).toEqual({ status: 'OK' });
    expectSingleProbe(createClient, runQuery);
  });

  it('row 3: WARNING pointing at posthog.identify when no persons have an email', async () => {
    const { checkHealth } = await loadHealth();
    const { deps, createClient, runQuery } = fakeDeps(() => Promise.resolve(probeResult(0)));

    const result = await checkHealth(deps);

    expectBanner(result, 'WARNING', 'No PostHog persons have an email', ['posthog.identify']);
    expectSingleProbe(createClient, runQuery);
  });
});

describe('checkHealth: rows 4 to 11, probe rejects with a PostHogError', () => {
  type ErrorRow = {
    row: number;
    kind: PostHogErrorKind;
    status: 'WARNING' | 'ERROR';
    title: string;
    fragments: () => string[];
    extra?: { retryAfterSeconds?: number | null };
    ignoreCase?: boolean;
  };
  const ROWS: ErrorRow[] = [
    {
      row: 4,
      kind: 'unauthorized',
      status: 'ERROR',
      title: 'Check the PostHog personal API key',
      fragments: () => [label('POSTHOG_HOST')],
    },
    {
      row: 5,
      kind: 'missing_scope',
      status: 'ERROR',
      title: 'Check the PostHog personal API key',
      fragments: () => ['query:read'],
    },
    {
      row: 6,
      kind: 'project_not_found',
      status: 'ERROR',
      title: 'Check the PostHog project ID',
      fragments: () => [SETTINGS.projectId],
    },
    {
      row: 7,
      kind: 'unreachable',
      status: 'ERROR',
      title: 'Check the PostHog host',
      fragments: () => [SETTINGS.host],
    },
    {
      row: 8,
      kind: 'rate_limited',
      status: 'WARNING',
      title: 'PostHog is rate limiting queries',
      fragments: () => ['37'],
      extra: { retryAfterSeconds: 37 },
    },
    {
      row: 9,
      kind: 'timeout',
      status: 'WARNING',
      title: 'PostHog did not answer in time',
      fragments: () => ['try again'],
      ignoreCase: true,
    },
    {
      row: 10,
      kind: 'server_error',
      status: 'ERROR',
      title: 'PostHog returned an error',
      fragments: () => [label('POSTHOG_HOST')],
    },
    {
      row: 11,
      kind: 'bad_query',
      status: 'ERROR',
      title: 'PostHog rejected the health check query',
      fragments: () => [],
    },
  ];

  it.each(ROWS)('row $row: $kind -> $status "$title"', async ({ kind, status, title, fragments, extra, ignoreCase }) => {
    const { checkHealth } = await loadHealth();
    const { deps, createClient, runQuery } = fakeDeps(() =>
      Promise.reject(new PostHogError(kind, 'HTTP detail from the client', extra)),
    );

    const result = await checkHealth(deps);

    if (ignoreCase) {
      expectBanner(result, status, title);
      const { description } = result as Extract<HealthResult, { title: string }>;
      for (const fragment of fragments()) expect(description.toLowerCase()).toContain(fragment);
    } else {
      expectBanner(result, status, title, fragments());
    }
    expectSingleProbe(createClient, runQuery);
  });

  it('row 8: rate limit without Retry-After still gives the WARNING', async () => {
    const { checkHealth } = await loadHealth();
    const { deps } = fakeDeps(() =>
      Promise.reject(new PostHogError('rate_limited', 'HTTP 429', { retryAfterSeconds: null })),
    );

    const result = await checkHealth(deps);

    expectBanner(result, 'WARNING', 'PostHog is rate limiting queries');
    expect(JSON.stringify(result)).not.toContain('null');
  });

  it.each(ROWS)('row $row: a $kind detail carrying the API key never reaches the banner', async ({ kind, extra }) => {
    const { checkHealth } = await loadHealth();
    const { deps } = fakeDeps(() =>
      Promise.reject(new PostHogError(kind, `HTTP 4xx: bad token ${SECRET}`, extra)),
    );

    const result = await checkHealth(deps);

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('checkHealth: row 12, unexpected failure', () => {
  const MESSAGE = `boom-unexpected-${SECRET}`;
  const CASES: [string, () => HealthDeps][] = [
    [
      'readSettings throws',
      () => ({
        readSettings: () => {
          throw new Error(MESSAGE);
        },
        createClient: () => ({ runQuery: () => Promise.resolve(probeResult(1)) }),
      }),
    ],
    [
      'createClient throws',
      () => ({
        readSettings: () => ({ ok: true, settings: SETTINGS }),
        createClient: () => {
          throw new Error(MESSAGE);
        },
      }),
    ],
    ['runQuery rejects with a plain Error', () => fakeDeps(() => Promise.reject(new Error(MESSAGE))).deps],
    ['runQuery rejects with a non-Error', () => fakeDeps(() => Promise.reject(MESSAGE)).deps],
    [
      'parseHealthProbe throws on a result without persons_with_email',
      () => fakeDeps(() => Promise.resolve({ columns: ['other'], results: [[MESSAGE]], bytesRead: null })).deps,
    ],
  ];

  it.each(CASES)('%s -> ERROR "The health check failed" without echoing the message', async (_name, build) => {
    const { checkHealth } = await loadHealth();

    const result = await checkHealth(build());

    expectBanner(result, 'ERROR', 'The health check failed');
    const json = JSON.stringify(result);
    expect(json).not.toContain('boom-unexpected');
    expect(json).not.toContain(SECRET);
  });
});

describe('checkHealth: no key leak on any row', () => {
  it('rows 1 to 3 never include the API key', async () => {
    const { checkHealth } = await loadHealth();
    const outcomes = [
      fakeDeps(() => Promise.resolve(probeResult(3))).deps,
      fakeDeps(() => Promise.resolve(probeResult(0))).deps,
      fakeDeps(() => Promise.resolve(probeResult(0)), {
        ok: false,
        problems: [{ key: 'POSTHOG_PROJECT_ID', reason: 'Enter the PostHog project ID.' }],
      }).deps,
    ];
    for (const deps of outcomes) {
      expect(JSON.stringify(await checkHealth(deps))).not.toContain(SECRET);
    }
  });
});

describe('checkHealth: default wiring', () => {
  it('with no argument, reads env settings and builds the client with PROBE_TIMEOUT_MS', async () => {
    vi.stubEnv('POSTHOG_HOST', 'https://us.posthog.com');
    vi.stubEnv('POSTHOG_CUSTOM_HOST', '');
    vi.stubEnv('POSTHOG_PROJECT_ID', '24680');
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', SECRET);
    defaultRunQuerySpy.mockResolvedValue(probeResult(5));
    const { checkHealth, PROBE_TIMEOUT_MS } = await loadHealth();

    const result = await checkHealth();

    expect(createPostHogClientSpy).toHaveBeenCalledTimes(1);
    expect(createPostHogClientSpy).toHaveBeenCalledWith(
      { host: 'https://us.posthog.com', projectId: '24680', apiKey: SECRET },
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    expect(defaultRunQuerySpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'OK' });
  });
});

describe('health check entity', () => {
  it('src/health-check.ts is a valid defineHealthCheck with a 15 s timeout above PROBE_TIMEOUT_MS', async () => {
    const entity = (await load<{ default: HealthCheckEntity }>('src/health-check.ts')).default;
    const { PROBE_TIMEOUT_MS } = await loadHealth();
    const identifier = (ids as Record<string, string>).HEALTH_CHECK_UNIVERSAL_IDENTIFIER;

    expect(entity.success).toBe(true);
    expect(entity.errors).toEqual([]);
    expect(identifier).toMatch(UUID_V4);
    expect(entity.config.universalIdentifier).toBe(identifier);
    expect(entity.config.name).toBe('posthog-health-check');
    expect(entity.config.timeoutSeconds).toBe(15);
    expect(PROBE_TIMEOUT_MS).toBe(12_000);
    expect(PROBE_TIMEOUT_MS).toBeLessThan((entity.config.timeoutSeconds ?? 0) * 1000);

    const others = Object.entries(ids as Record<string, string>)
      .filter(([name]) => name !== 'HEALTH_CHECK_UNIVERSAL_IDENTIFIER')
      .map(([, value]) => value);
    expect(others).not.toContain(identifier);
  });
});

describe('contract for TCA-32 (verified setup flow)', () => {
  it('exports checkHealth, PROBE_TIMEOUT_MS and a health-check entity whose handler returns a banner shape', async () => {
    const health = await loadHealth();
    expect(typeof health.checkHealth).toBe('function');
    expect(typeof health.PROBE_TIMEOUT_MS).toBe('number');

    const entity = (await load<{ default: HealthCheckEntity }>('src/health-check.ts')).default;
    expect(typeof entity.config.handler).toBe('function');
    expect(typeof entity.config.timeoutSeconds).toBe('number');

    // Unconfigured env: the handler must resolve to { status, title, description } without PostHog.
    for (const key of ['POSTHOG_HOST', 'POSTHOG_CUSTOM_HOST', 'POSTHOG_PROJECT_ID', 'POSTHOG_PERSONAL_API_KEY']) {
      vi.stubEnv(key, '');
    }
    const result = (await entity.config.handler()) as Record<string, unknown>;
    expect(typeof result.status).toBe('string');
    expect(typeof result.title).toBe('string');
    expect(typeof result.description).toBe('string');
    expect(createPostHogClientSpy).not.toHaveBeenCalled();
  });
});
