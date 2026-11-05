import type { ActivityEvent, ActivityResponse } from 'src/lib/activity';

// Above the route's 7 s PostHog timeout, so the route's own `timeout` status can still arrive.
export const ACTIVITY_REQUEST_TIMEOUT_MS = 8_000;

export type ActivityRequest =
  | { phase: 'loading' }
  | { phase: 'loaded'; response: ActivityResponse }
  | { phase: 'failed'; timedOut: boolean };

export type ActivityEventRow = Omit<ActivityEvent, 'timestamp'> & { relativeTime: string };

export type ActivityViewState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'events'; events: ActivityEventRow[]; profileUrl: string | null }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Route statuses that mean "nothing to show"; every other problem status is a retryable error.
const EMPTY_STATUSES = new Set(['not_configured', 'no_email', 'no_activity']);

const NO_ACTIVITY = 'No PostHog activity for this email';
const TIMED_OUT = 'PostHog took too long, try again';
const FAILED = 'Could not load PostHog activity';

export const selectedPersonId = (ids: string[]): string | null =>
  ids.length === 1 ? ids[0] : null;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

export const formatRelativeTime = (iso: string, now: Date): string => {
  const date = new Date(iso);
  const elapsed = now.getTime() - date.getTime();

  if (elapsed < MIN) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MIN)} min ago`;
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 2 * DAY) return 'yesterday';
  if (elapsed <= 30 * DAY) return plural(Math.floor(elapsed / DAY), 'day');
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

export const toViewState = (
  personId: string | null,
  request: ActivityRequest,
  now: Date,
): ActivityViewState => {
  if (personId === null) return { kind: 'hidden' };
  if (request.phase === 'loading') return { kind: 'loading' };
  if (request.phase === 'failed') {
    return { kind: 'error', message: request.timedOut ? TIMED_OUT : FAILED };
  }

  const { response } = request;
  if (response.status !== 'ok') {
    return { kind: EMPTY_STATUSES.has(response.status) ? 'empty' : 'error', message: response.message };
  }
  if (response.events.length === 0) return { kind: 'empty', message: NO_ACTIVITY };

  return {
    kind: 'events',
    events: response.events.map(({ event, url, timestamp }) => ({
      event,
      url,
      relativeTime: formatRelativeTime(timestamp, now),
    })),
    profileUrl: response.profileUrl,
  };
};
