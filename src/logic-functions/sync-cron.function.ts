import { defineLogicFunction } from 'twenty-sdk/define';
import type { CronPayload, LogicFunctionExecutionContext } from 'twenty-sdk/logic-function';

import { SYNC_CRON_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { enqueueSync } from 'src/lib/sync';

export default defineLogicFunction({
  universalIdentifier: SYNC_CRON_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'sync-cron',
  description: 'Hourly: enqueues the PostHog activity sync job. Does no other work.',
  cronTriggerSettings: { pattern: '0 * * * *' },
  handler: async (_payload: CronPayload, context: LogicFunctionExecutionContext) =>
    enqueueSync(context.workspaceId),
});
