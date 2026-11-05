// Shared by the route (src/lib/activity.ts) and the widget. No imports: the widget bundle runs in
// a Web Worker and must not pull in the route's server-side dependencies.

export const NO_ACTIVITY_MESSAGE = 'No PostHog activity for this email';
export const TIMEOUT_MESSAGE = 'PostHog took too long, try again';
export const GENERIC_MESSAGE = 'Could not load PostHog activity';

// The route's PostHog timeout stays below the widget's abort, so a `timeout` status can arrive.
export const ROUTE_POSTHOG_TIMEOUT_MS = 7_000;
export const ACTIVITY_REQUEST_TIMEOUT_MS = ROUTE_POSTHOG_TIMEOUT_MS + 1_000;
