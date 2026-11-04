import { defineHealthCheck } from 'twenty-sdk/define';

import { HEALTH_CHECK_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { checkHealth } from 'src/lib/health';

export default defineHealthCheck({
  universalIdentifier: HEALTH_CHECK_UNIVERSAL_IDENTIFIER,
  name: 'posthog-health-check',
  description: 'Runs one PostHog query to check the host, project ID and personal API key.',
  timeoutSeconds: 15,
  handler: () => checkHealth(),
});
