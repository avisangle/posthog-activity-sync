import type { QueryResult } from 'src/lib/posthog-client';

// Query texts: docs/decisions/D-TCA-22-posthog-api-shapes.md (activeSince, healthProbe verbatim);
// pageviewCounts and latestEvents bind the caller's window, D-TCA-24-caller-clock-windows.
// Every value is bound through `values`; nothing is interpolated into these strings.

export type BuiltQuery = { query: string; values: Record<string, unknown> };

export type QueryRows = Pick<QueryResult, 'columns' | 'results'>;

export type ActiveRow = {
  email: string;
  lastSeenAt: string;
  lastUrl: string | null;
  personRef: string;
};

export type LatestEvent = {
  event: string;
  url: string | null;
  timestamp: string;
  personRef: string;
};

const ACTIVE_SINCE_SQL =
  "SELECT lower(person.properties.email) AS email, max(timestamp) AS last_seen, argMaxIf(properties.$current_url, timestamp, event = '$pageview') AS last_url, argMax(person_id, timestamp) AS person_id FROM events WHERE timestamp >= {since} AND timestamp < {until} AND notEmpty(person.properties.email) GROUP BY email ORDER BY last_seen ASC LIMIT {limit}";

const PAGEVIEW_COUNTS_SQL =
  "SELECT lower(p.properties.email) AS email, coalesce(sum(c.pageviews), 0) AS pageviews_30d FROM persons AS p LEFT JOIN (SELECT person_id, uniqExact(uuid) AS pageviews FROM events WHERE event = '$pageview' AND timestamp >= {since} GROUP BY person_id) AS c ON c.person_id = p.id WHERE lower(p.properties.email) IN {emails} GROUP BY email ORDER BY email LIMIT {limit}";

const LATEST_EVENTS_SQL =
  'SELECT event, properties.$current_url AS url, timestamp, person_id FROM events WHERE lower(person.properties.email) = {email} AND timestamp >= {since} ORDER BY timestamp DESC LIMIT 1 BY uuid LIMIT {limit}';

const HEALTH_PROBE_SQL =
  'SELECT count() AS persons_with_email FROM persons WHERE notEmpty(properties.email)';

// PostHog silently clamps a larger LIMIT to 50,000 (D-TCA-22 observation 2).
const MAX_LIMIT = 50_000;
const DAY_MS = 86_400_000;
const PAGEVIEW_WINDOW_DAYS = 30;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();

const checkLimit = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_LIMIT}, got ${limit}`);
  }
  return limit;
};

export const activeSinceQuery = ({
  since,
  until,
  limit,
}: {
  since: Date;
  until: Date;
  limit: number;
}): BuiltQuery => ({
  query: ACTIVE_SINCE_SQL,
  values: { since: since.toISOString(), until: until.toISOString(), limit: checkLimit(limit) },
});

// Callers must skip the query for an empty list, and batch at most 50,000 emails.
export const pageviewCountsQuery = ({ emails, now }: { emails: string[]; now: Date }): BuiltQuery => {
  const list = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (list.length === 0) throw new Error('pageviewCountsQuery needs at least one email');
  return {
    query: PAGEVIEW_COUNTS_SQL,
    values: {
      emails: list,
      since: daysBefore(now, PAGEVIEW_WINDOW_DAYS),
      limit: checkLimit(list.length),
    },
  };
};

export const latestEventsQuery = ({
  email,
  now,
  limit = 20,
  days = 90,
}: {
  email: string;
  now: Date;
  limit?: number;
  days?: number;
}): BuiltQuery => ({
  query: LATEST_EVENTS_SQL,
  values: { email: normalizeEmail(email), since: daysBefore(now, days), limit: checkLimit(limit) },
});

export const healthProbeQuery = (): BuiltQuery => ({ query: HEALTH_PROBE_SQL, values: {} });

// Reads each row by column name, so a reordered `columns` cannot shift values.
const readRows = <Name extends string>(
  rows: QueryRows,
  names: readonly Name[],
): Record<Name, unknown>[] => {
  const indexes = names.map((name) => {
    const index = rows.columns.indexOf(name);
    if (index === -1) throw new Error(`PostHog result is missing the "${name}" column`);
    return index;
  });
  return rows.results.map(
    (row) =>
      Object.fromEntries(names.map((name, i) => [name, row[indexes[i]]])) as Record<Name, unknown>,
  );
};

const toUtcIso = (value: unknown) => new Date(String(value)).toISOString();

const toNullableString = (value: unknown) => (value === null || value === undefined ? null : String(value));

export const parseActiveRows = (rows: QueryRows): ActiveRow[] =>
  readRows(rows, ['email', 'last_seen', 'last_url', 'person_id'] as const).map((row) => ({
    email: String(row.email),
    lastSeenAt: toUtcIso(row.last_seen),
    lastUrl: toNullableString(row.last_url),
    personRef: String(row.person_id),
  }));

// An email absent from the map is not in PostHog persons.
export const parsePageviewCounts = (rows: QueryRows): Map<string, number> =>
  new Map(
    readRows(rows, ['email', 'pageviews_30d'] as const).map((row) => [
      String(row.email),
      Number(row.pageviews_30d),
    ]),
  );

export const parseLatestEvents = (rows: QueryRows): LatestEvent[] =>
  readRows(rows, ['event', 'url', 'timestamp', 'person_id'] as const).map((row) => ({
    event: String(row.event),
    url: toNullableString(row.url),
    timestamp: toUtcIso(row.timestamp),
    personRef: String(row.person_id),
  }));

export const parseHealthProbe = (rows: QueryRows): number =>
  Number(readRows(rows, ['persons_with_email'] as const)[0]?.persons_with_email ?? 0);

// `host` is readSettings().host, already resolved for POSTHOG_HOST=custom.
export const profileUrl = (host: string, projectId: string, personRef: string): string =>
  `${host}/project/${projectId}/persons/${encodeURIComponent(personRef)}`;
