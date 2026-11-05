import type { ActivityEvent, ActivityProblem, ActivityResponse } from 'src/lib/activity';
import {
  ACTIVITY_REQUEST_TIMEOUT_MS,
  GENERIC_MESSAGE,
  NO_ACTIVITY_MESSAGE,
  TIMEOUT_MESSAGE,
} from 'src/lib/activity-messages';

export { ACTIVITY_REQUEST_TIMEOUT_MS };

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

// A Record, so adding a route status fails typecheck until it is classified. Errors get "Try again".
const PROBLEM_KIND: Record<ActivityProblem, 'empty' | 'error'> = {
  not_configured: 'empty',
  no_email: 'empty',
  no_activity: 'empty',
  rate_limited: 'error',
  timeout: 'error',
  error: 'error',
};

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export const selectedPersonId = (ids: string[]): string | null =>
  ids.length === 1 ? ids[0] : null;

const ago = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

export const formatRelativeTime = (iso: string, now: Date): string => {
  const date = new Date(iso);
  const elapsed = now.getTime() - date.getTime();

  if (elapsed < MIN) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MIN)} min ago`;
  if (elapsed < DAY) return ago(Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 2 * DAY) return 'yesterday';
  if (elapsed <= 30 * DAY) return ago(Math.floor(elapsed / DAY), 'day');
  return DATE_FORMAT.format(date);
};

export const toViewState = (
  personId: string | null,
  request: ActivityRequest,
  now: Date,
): ActivityViewState => {
  if (personId === null) return { kind: 'hidden' };
  if (request.phase === 'loading') return { kind: 'loading' };
  if (request.phase === 'failed') {
    return { kind: 'error', message: request.timedOut ? TIMEOUT_MESSAGE : GENERIC_MESSAGE };
  }

  const { response } = request;
  if (response.status !== 'ok') {
    return { kind: PROBLEM_KIND[response.status], message: response.message };
  }
  if (response.events.length === 0) return { kind: 'empty', message: NO_ACTIVITY_MESSAGE };

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
