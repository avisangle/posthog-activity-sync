import { CoreApiClient } from 'twenty-client-sdk/core';

import { createPostHogClient, PostHogError, type PostHogErrorKind } from 'src/lib/posthog-client';
import { latestEventsQuery, parseLatestEvents, profileUrl } from 'src/lib/queries';
import { readSettings } from 'src/lib/settings';

export type ActivityEvent = { event: string; url: string | null; timestamp: string };

type ActivityProblem =
  | 'not_configured'
  | 'no_email'
  | 'no_activity'
  | 'rate_limited'
  | 'timeout'
  | 'error';

// Always returned with HTTP 200: RestApiClient throws on non-2xx (TCA-20 "Route errors").
export type ActivityResponse =
  | { status: 'ok'; events: ActivityEvent[]; profileUrl: string | null }
  | { status: ActivityProblem; message: string };

type ActivityDeps = {
  readSettings: typeof readSettings;
  readPrimaryEmail: (personId: string) => Promise<string | null>;
  createClient: typeof createPostHogClient;
  now: () => Date;
};

// Below the widget's 8 s abort, so a timeout status can still reach it.
const CLIENT_TIMEOUT_MS = 7_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONNECTION_FAILED = "PostHog connection failed; an admin should check Settings > Apps";
const GENERIC = 'Could not load PostHog activity';

const problem = (status: ActivityProblem, message: string): ActivityResponse => ({ status, message });

// A Record, so adding or removing a kind in posthog-client.ts fails typecheck.
const ERROR_RESPONSES: Record<PostHogErrorKind, ActivityResponse> = {
  rate_limited: problem('rate_limited', 'PostHog is busy, try again in a minute'),
  timeout: problem('timeout', 'PostHog took too long, try again'),
  unauthorized: problem('error', CONNECTION_FAILED),
  missing_scope: problem('error', CONNECTION_FAILED),
  project_not_found: problem('error', CONNECTION_FAILED),
  unreachable: problem('error', CONNECTION_FAILED),
  bad_query: problem('error', GENERIC),
  server_error: problem('error', GENERIC),
};

export const readPrimaryEmail = async (personId: string): Promise<string | null> => {
  const client = new CoreApiClient();
  const result = await client.query({
    person: {
      __args: { filter: { id: { eq: personId } } },
      emails: { primaryEmail: true },
    },
  });
  return result.person?.emails?.primaryEmail ?? null;
};

const DEFAULT_DEPS: ActivityDeps = {
  readSettings,
  readPrimaryEmail,
  createClient: createPostHogClient,
  now: () => new Date(),
};

// Never throws; PostHog error details and the key never reach the response.
export const getActivity = async (
  personId: string | undefined,
  overrides: Partial<ActivityDeps> = {},
): Promise<ActivityResponse> => {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  if (!personId || !UUID.test(personId)) return problem('error', 'Missing person id');

  const config = deps.readSettings();
  if (!config.ok) return problem('not_configured', 'Connect PostHog in Settings > Apps');

  try {
    // latestEventsQuery lowercases before binding.
    const email = (await deps.readPrimaryEmail(personId))?.trim();
    if (!email) return problem('no_email', 'No email on this person');

    const { host, projectId } = config.settings;
    const client = deps.createClient(config.settings, { timeoutMs: CLIENT_TIMEOUT_MS });
    const events = parseLatestEvents(
      await client.runQuery({ ...latestEventsQuery({ email, now: deps.now() }), name: 'activity-route' }),
    );
    if (events.length === 0) return problem('no_activity', 'No PostHog activity for this email');

    return {
      status: 'ok',
      events: events.map(({ event, url, timestamp }) => ({ event, url, timestamp })),
      profileUrl: profileUrl(host, projectId, events[0].personRef),
    };
  } catch (error) {
    return error instanceof PostHogError ? { ...ERROR_RESPONSES[error.kind] } : problem('error', GENERIC);
  }
};
