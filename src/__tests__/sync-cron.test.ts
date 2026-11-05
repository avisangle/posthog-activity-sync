// TCA-29 red-phase tests: the hourly cron (src/logic-functions/sync-cron.function.ts) and the
// sync job (src/logic-functions/sync-job.function.ts).
//
// External facts (twenty-sdk 2.54.3, node_modules/twenty-sdk/dist):
//  - defineLogicFunction(...) returns { success, config, errors }; config.cronTriggerSettings is
//    { pattern }; the handler is (payload, context: LogicFunctionExecutionContext) with
//    context = { retryCount, maxRetries, workspaceId, userWorkspaceId, workspaceMemberId }.
//  - enqueueJobs(input: { logicFunctionUniversalIdentifier, jobs?: { jobId?, payload? }[],
//    retryLimit?, delayMs? }) -> { enqueued, logicFunctionUniversalIdentifier, enqueuedJobsCount,
//    jobIds } from twenty-sdk/logic-function. Mocked here, with kv.
//  - hourBucketJobId('posthog-sync', now) -> 'posthog-sync:YYYY-MM-DDTHH';
//    stableOffsetMs(id, JOB_OFFSET_WINDOW_MS = 3,000,000): ws-1 -> 941829, ws-2 -> 1608972
//    (fixtures from src/__tests__/jobs.test.ts).
//
// Pinned names: SYNC_CRON_FUNCTION_UNIVERSAL_IDENTIFIER and SYNC_JOB_FUNCTION_UNIVERSAL_IDENTIFIER
// in src/constants/universal-identifiers.ts. Modules load by absolute path so this file runs
// before they exist.
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as identifiers from 'src/constants/universal-identifiers';
import { ACTIVITY_WRITE_LEASE } from 'src/lib/jobs';

const sdk = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    enqueueJobs: vi.fn(),
    get: vi.fn(async (key: string) => (store.has(key) ? JSON.parse(store.get(key) as string) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, JSON.stringify(value));
    }),
    delete: vi.fn(async (key: string) => store.delete(key)),
  };
});
vi.mock('twenty-sdk/logic-function', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueJobs: sdk.enqueueJobs,
  kv: { get: sdk.get, set: sdk.set, delete: sdk.delete },
}));

const core = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));
vi.mock('twenty-client-sdk/core', () => ({
  CoreApiClient: class {
    query = core.query;
    mutation = core.mutation;
  },
}));

type Context = {
  retryCount: number;
  maxRetries: number;
  workspaceId: string;
  userWorkspaceId: string | null;
  workspaceMemberId: string | null;
};
type FunctionModule = {
  default: {
    success: boolean;
    errors: string[];
    config: {
      universalIdentifier: string;
      timeoutSeconds?: number;
      cronTriggerSettings?: { pattern: string };
      handler: (payload: Record<string, never>, context: Context) => Promise<unknown>;
    };
  };
};

const loadCron = async (): Promise<FunctionModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/logic-functions/sync-cron.function.ts'));
const loadJob = async (): Promise<FunctionModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/logic-functions/sync-job.function.ts'));

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const context = (workspaceId: string): Context => ({
  retryCount: 0,
  maxRetries: 0,
  workspaceId,
  userWorkspaceId: null,
  workspaceMemberId: null,
});

beforeEach(() => {
  sdk.store.clear();
  sdk.get.mockClear();
  sdk.set.mockClear();
  sdk.delete.mockClear();
  sdk.enqueueJobs.mockReset();
  sdk.enqueueJobs.mockImplementation(async (input: { logicFunctionUniversalIdentifier: string }) => ({
    enqueued: true,
    logicFunctionUniversalIdentifier: input.logicFunctionUniversalIdentifier,
    enqueuedJobsCount: 1,
    jobIds: ['fake'],
  }));
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('sync logic functions: registration', () => {
  it('the cron runs hourly at minute 0; the job times out at 300 s; both have their own declared UUID v4', async () => {
    const cron = (await loadCron()).default;
    const job = (await loadJob()).default;

    expect(cron.errors).toEqual([]);
    expect(cron.success).toBe(true);
    expect(cron.config.cronTriggerSettings).toEqual({ pattern: '0 * * * *' });

    expect(job.errors).toEqual([]);
    expect(job.success).toBe(true);
    expect(job.config.timeoutSeconds).toBe(300);
    expect(job.config.cronTriggerSettings).toBeUndefined();

    const ids = identifiers as unknown as Record<string, string>;
    expect(cron.config.universalIdentifier).toBe(ids.SYNC_CRON_FUNCTION_UNIVERSAL_IDENTIFIER);
    expect(job.config.universalIdentifier).toBe(ids.SYNC_JOB_FUNCTION_UNIVERSAL_IDENTIFIER);
    for (const id of [cron.config.universalIdentifier, job.config.universalIdentifier]) {
      expect(id).toMatch(UUID_V4);
      expect(Object.values(ids).filter((value) => value === id)).toHaveLength(1);
    }
  });
});

describe('sync-cron handler', () => {
  it('enqueues one job with the hour-bucket id, the stable per-workspace delay and retryLimit 0, and does nothing else', async () => {
    const cron = (await loadCron()).default;
    const jobId = (await loadJob()).default.config.universalIdentifier;
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(new Date('2026-11-05T12:00:03.000Z'));
    await cron.config.handler({}, context('ws-1'));
    vi.setSystemTime(new Date('2026-11-05T12:59:59.999Z'));
    await cron.config.handler({}, context('ws-1'));
    vi.setSystemTime(new Date('2026-11-05T13:00:00.000Z'));
    await cron.config.handler({}, context('ws-2'));

    expect(sdk.enqueueJobs.mock.calls.map(([input]) => input)).toEqual([
      {
        logicFunctionUniversalIdentifier: jobId,
        jobs: [{ jobId: 'posthog-sync:2026-11-05T12' }],
        delayMs: 941829,
        retryLimit: 0,
      },
      // Same UTC hour, same id: the queue dedupes a second fire.
      {
        logicFunctionUniversalIdentifier: jobId,
        jobs: [{ jobId: 'posthog-sync:2026-11-05T12' }],
        delayMs: 941829,
        retryLimit: 0,
      },
      // The delay comes from the context's workspace id, not a constant.
      {
        logicFunctionUniversalIdentifier: jobId,
        jobs: [{ jobId: 'posthog-sync:2026-11-05T13' }],
        delayMs: 1608972,
        retryLimit: 0,
      },
    ]);

    // The cron only enqueues: no KV, no lease, no Twenty, no PostHog.
    expect(sdk.get).not.toHaveBeenCalled();
    expect(sdk.set).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('sync-job handler', () => {
  it('runs runSync with the real deps: empty settings return not_configured after taking and releasing the shared lease', async () => {
    const job = (await loadJob()).default;
    for (const key of ['POSTHOG_HOST', 'POSTHOG_CUSTOM_HOST', 'POSTHOG_PROJECT_ID', 'POSTHOG_PERSONAL_API_KEY']) {
      vi.stubEnv(key, '');
    }

    await expect(job.config.handler({}, context('ws-1'))).resolves.toMatchObject({
      status: 'not_configured',
    });

    expect(sdk.set.mock.calls.map(([key]) => key)).toContain(ACTIVITY_WRITE_LEASE);
    expect(sdk.store.has(ACTIVITY_WRITE_LEASE)).toBe(false);
    expect(sdk.store.has('sync:cursor')).toBe(false);
    expect(sdk.enqueueJobs).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
