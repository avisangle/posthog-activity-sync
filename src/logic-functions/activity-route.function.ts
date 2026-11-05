import { defineLogicFunction, HTTPMethod, type RoutePayload } from 'twenty-sdk/define';

import { ACTIVITY_ROUTE_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { getActivity } from 'src/lib/activity';

export default defineLogicFunction({
  universalIdentifier: ACTIVITY_ROUTE_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'activity-route',
  description: "Latest PostHog events for a person, for the Product activity widget.",
  timeoutSeconds: 15,
  httpRouteTriggerSettings: {
    path: '/activity',
    httpMethod: HTTPMethod.GET,
    isAuthRequired: true,
  },
  handler: async (event: RoutePayload) => getActivity(event.queryStringParameters.personId),
});
