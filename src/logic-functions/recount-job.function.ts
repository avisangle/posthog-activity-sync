import { defineLogicFunction } from 'twenty-sdk/define';

import { RECOUNT_JOB_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { RECOUNT_TIMEOUT_SECONDS, runRecount } from 'src/lib/recount';

export default defineLogicFunction({
  universalIdentifier: RECOUNT_JOB_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'recount-job',
  description: 'Recounts 30-day page views and clears people deleted from PostHog.',
  timeoutSeconds: RECOUNT_TIMEOUT_SECONDS,
  handler: async () => runRecount(),
});
