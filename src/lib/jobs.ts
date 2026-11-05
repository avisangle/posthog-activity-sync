import { enqueueJobs, kv } from 'twenty-sdk/logic-function';

import { PostHogError } from 'src/lib/posthog-client';
import { TwentyRateLimitError } from 'src/lib/twenty-errors';

// Scheduling: D-TCA-27-job-scheduling. Lease: D-TCA-27-shared-write-lease.

// The one lease every job that calls writeActivity holds from before its first read.
export const ACTIVITY_WRITE_LEASE = 'activity-write-lease';

// The windowMs every cron passes to stableOffsetMs, so sync and recount stay 30 minutes apart.
export const JOB_OFFSET_WINDOW_MS = 50 * 60_000;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// 32-bit FNV-1a over the UTF-8 bytes of the id, unsigned, modulo windowMs.
export const stableOffsetMs = (workspaceId: string, windowMs: number): number => {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(workspaceId)) {
    hash = Math.imul(hash ^ byte, FNV_PRIME);
  }
  return (hash >>> 0) % windowMs;
};

export const hourBucketJobId = (prefix: string, now: Date): string =>
  `${prefix}:${now.toISOString().slice(0, 13)}`;

export const dayBucketJobId = (prefix: string, now: Date): string =>
  `${prefix}:${now.toISOString().slice(0, 10)}`;

// A cron's whole job: one bucketed enqueue, delayed by the workspace offset, never retried.
export const enqueueBucketedJob = (
  logicFunctionUniversalIdentifier: string,
  jobId: string,
  workspaceId: string,
) =>
  enqueueJobs({
    logicFunctionUniversalIdentifier,
    jobs: [{ jobId }],
    delayMs: stableOffsetMs(workspaceId, JOB_OFFSET_WINDOW_MS),
    retryLimit: 0,
  });

type Lease = { expiresAt: string };

// Check-then-set: KV has no compare-and-set.
export const acquireLease = async (key: string, now: Date, ttlSeconds: number): Promise<boolean> => {
  const held = await kv.get<Lease>(key);
  if (held && Date.parse(held.expiresAt) > now.getTime()) return false;
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  await kv.set<Lease>(key, { expiresAt });
  return true;
};

export const releaseLease = async (key: string): Promise<void> => {
  await kv.delete(key);
};

// The statuses a failed job run reports. Every job stops on the first error and keeps its state.
export type JobFailureStatus = 'rate_limited' | 'timeout' | 'error';

export const jobFailureStatus = (error: unknown): JobFailureStatus => {
  if (error instanceof TwentyRateLimitError) return 'rate_limited';
  if (error instanceof PostHogError && (error.kind === 'rate_limited' || error.kind === 'timeout')) {
    return error.kind;
  }
  return 'error';
};
