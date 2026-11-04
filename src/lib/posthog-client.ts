import type { PostHogSettings } from 'src/lib/settings';

// Status and body mapping: docs/decisions/D-TCA-22-posthog-api-shapes.md, Error matrix.
export type PostHogErrorKind =
  | 'unauthorized'
  | 'missing_scope'
  | 'project_not_found'
  | 'rate_limited'
  | 'timeout'
  | 'bad_query'
  | 'unreachable'
  | 'server_error';

export type QueryResult = { columns: string[]; results: unknown[][]; bytesRead: number | null };

export type RunQueryInput = { query: string; values?: Record<string, unknown>; name: string };

type ClientOptions = { fetch?: typeof fetch; timeoutMs?: number };

export class PostHogError extends Error {
  readonly kind: PostHogErrorKind;
  readonly detail: string;
  readonly retryAfterSeconds: number | null;
  readonly budgetExceeded: boolean;

  constructor(
    kind: PostHogErrorKind,
    detail: string,
    extra: { retryAfterSeconds?: number | null; budgetExceeded?: boolean } = {},
  ) {
    super(`PostHog ${kind}: ${detail}`);
    this.name = 'PostHogError';
    this.kind = kind;
    this.detail = detail;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.budgetExceeded = extra.budgetExceeded ?? false;
  }
}

// Longer than PostHog's 10 s execution limit, so its 504 normally arrives first.
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LENGTH = 500;

const parseCount = (raw: string | null): number | null =>
  raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw) : null;

// Retry-After is either delta seconds or an HTTP date.
const parseRetryAfter = (raw: string | null): number | null => {
  const seconds = parseCount(raw);
  if (seconds !== null || raw === null) return seconds;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
};

const parseJson = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// Node's fetch puts the network reason (e.g. ENOTFOUND) in `cause`.
const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const { cause } = error as { cause?: unknown };
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
};

const kindFor = (status: number, code: unknown, detail: string): PostHogErrorKind => {
  if (status === 401) return 'unauthorized';
  if (status === 403) {
    if (code === 'permission_denied') {
      if (detail.startsWith('API key missing required scope')) return 'missing_scope';
      if (detail.includes('does not have access to the requested project')) {
        return 'project_not_found';
      }
    }
    return 'unauthorized';
  }
  if (status === 404) return 'project_not_found';
  if (status === 429) return 'rate_limited';
  if (status === 504) return 'timeout';
  if (status >= 400 && status < 500) return 'bad_query';
  return 'server_error';
};

export const createPostHogClient = (settings: PostHogSettings, options: ClientOptions = {}) => {
  const { host, projectId, apiKey } = settings;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const redact = (text: string) => (apiKey === '' ? text : text.split(apiKey).join('[redacted]'));

  const runQuery = async ({ query, values, name }: RunQueryInput): Promise<QueryResult> => {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await (options.fetch ?? fetch)(`${host}/api/projects/${projectId}/query/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: { kind: 'HogQLQuery', query, values },
          refresh: 'force_blocking',
          name,
        }),
        signal,
      });
      text = await response.text();
    } catch (error) {
      if (signal.aborted) throw new PostHogError('timeout', `No response within ${timeoutMs} ms.`);
      throw new PostHogError('unreachable', redact(errorText(error)));
    }

    const body = parseJson(text);

    if (response.ok) {
      if (!Array.isArray(body?.columns) || !Array.isArray(body?.results)) {
        throw new PostHogError('server_error', 'Unexpected query response shape.');
      }
      return {
        columns: body.columns,
        results: body.results,
        bytesRead: parseCount(response.headers.get('X-PostHog-Query-Bytes-Read')),
      };
    }

    const rawDetail = typeof body?.detail === 'string' ? body.detail : text;
    throw new PostHogError(
      kindFor(response.status, body?.code, rawDetail),
      `HTTP ${response.status}: ${redact(rawDetail).slice(0, MAX_DETAIL_LENGTH)}`,
      {
        retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
        budgetExceeded: body?.code === 'api_queries_budget_exceeded',
      },
    );
  };

  return { runQuery };
};
