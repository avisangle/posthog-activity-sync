import application from 'src/application-config';
import {
  createPostHogClient,
  PostHogError,
  type PostHogErrorKind,
  type QueryResult,
  type RunQueryInput,
} from 'src/lib/posthog-client';
import { healthProbeQuery, parseHealthProbe } from 'src/lib/queries';
import {
  readSettings,
  type PostHogSettings,
  type SettingsProblem,
  type SettingsResult,
} from 'src/lib/settings';

// Same shape as twenty-sdk's ApplicationHealthCheckResult, narrowed to what this check returns.
export type HealthResult =
  | { status: 'OK' }
  | { status: 'WARNING' | 'ERROR'; title: string; description: string };

export type HealthDeps = {
  readSettings: () => SettingsResult;
  createClient: (settings: PostHogSettings) => {
    runQuery: (input: RunQueryInput) => Promise<QueryResult>;
  };
};

// Below the handler's timeoutSeconds (15), so a slow PostHog yields the timeout row, not a killed function.
export const PROBE_TIMEOUT_MS = 12_000;

type Banner = Exclude<HealthResult, { status: 'OK' }>;

// Banners name settings by their label in application-config, so a rename cannot leave a stale name.
const variables: Record<string, { label?: string }> = application.config.applicationVariables ?? {};
const label = (key: string) => variables[key]?.label ?? key;

const HOST = label('POSTHOG_HOST');
const PROJECT_ID = label('POSTHOG_PROJECT_ID');
const API_KEY = label('POSTHOG_PERSONAL_API_KEY');

const banner = (status: Banner['status'], title: string, description: string): Banner => ({
  status,
  title,
  description,
});

const settingsBanner = (problems: SettingsProblem[]): Banner =>
  banner(
    'ERROR',
    `Check the ${label(problems[0].key)}`,
    problems.map((problem) => `${label(problem.key)}: ${problem.reason}`).join(' '),
  );

const NO_EMAIL = banner(
  'WARNING',
  'No PostHog persons have an email',
  'PostHog is connected, but no person in this project has an email property, so nobody can be matched to Twenty people. Call posthog.identify with an email property when your users sign in.',
);

const FAILED = banner(
  'ERROR',
  'The health check failed',
  'The check stopped on an unexpected error. Reload this page to run it again.',
);

// Maps on error.kind only; `detail` is never shown.
const ERROR_BANNERS: Record<PostHogErrorKind, (settings: PostHogSettings, error: PostHogError) => Banner> = {
  unauthorized: () =>
    banner(
      'ERROR',
      `Check the ${API_KEY}`,
      `PostHog did not accept the key. Check that it is correct and not revoked, and that the ${HOST} is the region the key was created in: a US key is unknown on the EU cloud, and the reverse.`,
    ),
  missing_scope: () =>
    banner(
      'ERROR',
      `Check the ${API_KEY}`,
      'The key is missing the query:read scope. Edit the key in PostHog and add query:read.',
    ),
  project_not_found: (settings) =>
    banner(
      'ERROR',
      `Check the ${PROJECT_ID}`,
      `The key cannot read PostHog project ${settings.projectId}. Check the project ID, and that the key is allowed to access that project.`,
    ),
  unreachable: (settings) =>
    banner('ERROR', `Check the ${HOST}`, `Could not connect to PostHog at ${settings.host}.`),
  rate_limited: (_settings, error) =>
    banner(
      'WARNING',
      'PostHog is rate limiting queries',
      error.retryAfterSeconds === null
        ? 'Wait a minute, then reload this page to try again.'
        : `Wait ${error.retryAfterSeconds} seconds, then reload this page to try again.`,
    ),
  timeout: () =>
    banner(
      'WARNING',
      'PostHog did not answer in time',
      'The settings may be fine. Reload this page to try again.',
    ),
  server_error: () =>
    banner(
      'ERROR',
      'PostHog returned an error',
      `PostHog answered with a server error or an unexpected response. Check that the ${HOST} points at PostHog, then try again later.`,
    ),
  bad_query: () =>
    banner(
      'ERROR',
      'PostHog rejected the health check query',
      'This PostHog instance did not accept a HogQL query. Self-hosted instances may need an upgrade.',
    ),
};

const defaultDeps: HealthDeps = {
  readSettings,
  createClient: (settings) => createPostHogClient(settings, { timeoutMs: PROBE_TIMEOUT_MS }),
};

// Never rejects: Twenty shows no banner for a handler that throws.
export const checkHealth = async (deps: HealthDeps = defaultDeps): Promise<HealthResult> => {
  let settings: PostHogSettings | undefined;
  try {
    const read = deps.readSettings();
    if (!read.ok) return settingsBanner(read.problems);
    settings = read.settings;
    const result = await deps
      .createClient(settings)
      .runQuery({ ...healthProbeQuery(), name: 'health_check' });
    return parseHealthProbe(result) >= 1 ? { status: 'OK' } : NO_EMAIL;
  } catch (error) {
    return error instanceof PostHogError && settings
      ? ERROR_BANNERS[error.kind](settings, error)
      : FAILED;
  }
};
