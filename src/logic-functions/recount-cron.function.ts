import { defineLogicFunction, type CronPayload } from 'twenty-sdk/define';
import { enqueueJobs, type LogicFunctionExecutionContext } from 'twenty-sdk/logic-function';

import {
  RECOUNT_CRON_FUNCTION_UNIVERSAL_IDENTIFIER,
  RECOUNT_JOB_FUNCTION_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';
import { dayBucketJobId, JOB_OFFSET_WINDOW_MS, stableOffsetMs } from 'src/lib/jobs';

// Scheduling: D-TCA-27-job-scheduling. Starts 30 minutes after this workspace's 03:00 sync.
export default defineLogicFunction({
  universalIdentifier: RECOUNT_CRON_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'recount-cron',
  description: 'Enqueues the daily PostHog page view recount.',
  cronTriggerSettings: { pattern: '30 3 * * *' },
  handler: async (_payload: CronPayload, { workspaceId }: LogicFunctionExecutionContext) =>
    enqueueJobs({
      logicFunctionUniversalIdentifier: RECOUNT_JOB_FUNCTION_UNIVERSAL_IDENTIFIER,
      jobs: [{ jobId: dayBucketJobId('posthog-recount', new Date()) }],
      delayMs: stableOffsetMs(workspaceId, JOB_OFFSET_WINDOW_MS),
      retryLimit: 0,
    }),
});
