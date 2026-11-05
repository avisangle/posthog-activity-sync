import { defineLogicFunction } from 'twenty-sdk/define';

import { RECOUNT_JOB_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { runRecount } from 'src/lib/recount';

export default defineLogicFunction({
  universalIdentifier: RECOUNT_JOB_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'recount-job',
  description: 'Recounts 30-day page views and clears people deleted from PostHog.',
  timeoutSeconds: 300,
  handler: async () => runRecount(),
});
