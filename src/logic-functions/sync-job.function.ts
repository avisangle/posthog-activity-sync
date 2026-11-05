import { defineLogicFunction } from 'twenty-sdk/define';

import { SYNC_JOB_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { runSync } from 'src/lib/sync';

export default defineLogicFunction({
  universalIdentifier: SYNC_JOB_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'sync-job',
  description: 'Copies PostHog activity since the last run into the four Person fields.',
  timeoutSeconds: 300,
  handler: async () => runSync(),
});
