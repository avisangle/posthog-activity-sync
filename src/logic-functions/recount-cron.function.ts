import { defineLogicFunction } from 'twenty-sdk/define';
import type { CronPayload, LogicFunctionExecutionContext } from 'twenty-sdk/logic-function';

import { RECOUNT_CRON_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { enqueueRecount } from 'src/lib/recount';

// Scheduling: D-TCA-27-job-scheduling. Starts 30 minutes after this workspace's 03:00 hourly sync.
export default defineLogicFunction({
  universalIdentifier: RECOUNT_CRON_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'recount-cron',
  description: 'Daily: enqueues the PostHog page view recount job. Does no other work.',
  cronTriggerSettings: { pattern: '30 3 * * *' },
  handler: async (_payload: CronPayload, context: LogicFunctionExecutionContext) =>
    enqueueRecount(context.workspaceId),
});
