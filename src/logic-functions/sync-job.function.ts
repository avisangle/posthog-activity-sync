import { defineLogicFunction } from 'twenty-sdk/define';

import { SYNC_JOB_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { runSync, SYNC_TIMEOUT_SECONDS } from 'src/lib/sync';

export default defineLogicFunction({
  universalIdentifier: SYNC_JOB_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'sync-job',
  description: 'Copies PostHog activity since the last run into the four Person fields.',
  timeoutSeconds: SYNC_TIMEOUT_SECONDS,
  handler: async () => runSync(),
});
