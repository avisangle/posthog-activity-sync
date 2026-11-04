// All HogQL the app sends. Texts from D-TCA-22; windows and limits bound per D-TCA-24.
// Every caller value goes through `values`, never into the query string.

export type BuiltQuery = { query: string; values: Record<string, unknown> };
export type QueryRows = { columns: string[]; results: unknown[][] };

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

const DAY_MS = 86_400_000;
const PAGEVIEW_WINDOW_DAYS = 30;
// PostHog clamps a larger LIMIT to 50,000 without signalling truncation (D-TCA-22).
const MAX_LIMIT = 50_000;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const iso = (date: Date) => date.toISOString();

const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

const checkLimit = (limit: number) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`HogQL LIMIT must be an integer from 1 to ${MAX_LIMIT}, got ${limit}`);
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
  values: { since: iso(since), until: iso(until), limit: checkLimit(limit) },
});

// One row per email present in PostHog persons; absent email = not in PostHog.
export const pageviewCountsQuery = ({ emails, now }: { emails: string[]; now: Date }): BuiltQuery => {
  const list = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (list.length === 0) throw new Error('pageviewCountsQuery needs at least one email');
  return {
    query: PAGEVIEW_COUNTS_SQL,
    values: {
      emails: list,
      since: iso(daysBefore(now, PAGEVIEW_WINDOW_DAYS)),
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
  values: {
    email: normalizeEmail(email),
    since: iso(daysBefore(now, days)),
    limit: checkLimit(limit),
  },
});

export const healthProbeQuery = (): BuiltQuery => ({ query: HEALTH_PROBE_SQL, values: {} });

// Maps each wanted column to its index; throws naming the first one missing.
const columnIndex = <K extends string>(columns: string[], wanted: readonly K[]) => {
  const index = {} as Record<K, number>;
  for (const name of wanted) {
    const i = columns.indexOf(name);
    if (i === -1) throw new Error(`PostHog result is missing column "${name}"`);
    index[name] = i;
  }
  return index;
};

const nullableString = (value: unknown) => (value == null ? null : String(value));

const isoTimestamp = (value: unknown) => new Date(String(value)).toISOString();

export const parseActiveRows = ({ columns, results }: QueryRows): ActiveRow[] => {
  const col = columnIndex(columns, ['email', 'last_seen', 'last_url', 'person_id'] as const);
  return results.map((row) => ({
    email: String(row[col.email]),
    lastSeenAt: isoTimestamp(row[col.last_seen]),
    lastUrl: nullableString(row[col.last_url]),
    personRef: String(row[col.person_id]),
  }));
};

export const parsePageviewCounts = ({ columns, results }: QueryRows): Map<string, number> => {
  const col = columnIndex(columns, ['email', 'pageviews_30d'] as const);
  return new Map(results.map((row) => [String(row[col.email]), Number(row[col.pageviews_30d])]));
};

export const parseLatestEvents = ({ columns, results }: QueryRows): LatestEvent[] => {
  const col = columnIndex(columns, ['event', 'url', 'timestamp', 'person_id'] as const);
  return results.map((row) => ({
    event: String(row[col.event]),
    url: nullableString(row[col.url]),
    timestamp: isoTimestamp(row[col.timestamp]),
    personRef: String(row[col.person_id]),
  }));
};

export const parseHealthProbe = ({ columns, results }: QueryRows): number => {
  const col = columnIndex(columns, ['persons_with_email'] as const);
  return Number(results[0]?.[col.persons_with_email] ?? 0);
};

// `host` is the app host (POSTHOG_HOST), not the `.i.` ingestion host.
export const profileUrl = (host: string, projectId: string, personRef: string): string =>
  `${host}/project/${projectId}/persons/${encodeURIComponent(personRef)}`;
