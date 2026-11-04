export type PostHogSettings = { host: string; projectId: string; apiKey: string };

export type SettingsProblem = { key: string; reason: string };

export type SettingsResult =
  | { ok: true; settings: PostHogSettings }
  | { ok: false; problems: SettingsProblem[] };

type Env = Record<string, string | undefined>;

const clean = (value: string | undefined) => (value ?? '').trim().replace(/\/+$/, '');

// Returns a reason when the host is unusable, else null.
const hostProblem = (host: string): string | null => {
  if (host === '') return 'Enter the PostHog host.';
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return 'The PostHog host must be a full URL starting with https://.';
  }
  if (url.protocol !== 'https:') return 'The PostHog host must start with https://.';
  if (url.hostname.toLowerCase().endsWith('.i.posthog.com')) {
    return 'This is the PostHog ingestion host (*.i.posthog.com). Use the app host, such as https://us.posthog.com.';
  }
  return null;
};

export const readSettings = (env: Env = process.env): SettingsResult => {
  const problems: SettingsProblem[] = [];

  const hostKey = clean(env.POSTHOG_HOST) === 'custom' ? 'POSTHOG_CUSTOM_HOST' : 'POSTHOG_HOST';
  const host = clean(env[hostKey]);
  const hostReason = hostProblem(host);
  if (hostReason) problems.push({ key: hostKey, reason: hostReason });

  const projectId = clean(env.POSTHOG_PROJECT_ID);
  if (projectId === '') {
    problems.push({ key: 'POSTHOG_PROJECT_ID', reason: 'Enter the PostHog project ID.' });
  }

  const apiKey = (env.POSTHOG_PERSONAL_API_KEY ?? '').trim();
  if (apiKey === '') {
    problems.push({
      key: 'POSTHOG_PERSONAL_API_KEY',
      reason: 'Enter a PostHog personal API key with the query:read scope.',
    });
  }

  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, settings: { host, projectId, apiKey } };
};
