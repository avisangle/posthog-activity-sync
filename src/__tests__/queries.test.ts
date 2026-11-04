// TCA-24 red-phase tests: HogQL builders, row parsers and profile URL (src/lib/queries.ts).
//
// External facts, from docs/decisions/D-TCA-22-posthog-api-shapes.md (observed 2026-11-04):
//  - Placeholders are `{name}`; `values` binds ISO strings, integers (`LIMIT {limit}`) and a
//    JSON array to `IN {emails}`.
//  - TCA-23's runQuery returns `{ columns, results, bytesRead }`; `results` rows are arrays in
//    `columns` order. DateTime64 comes back as `2026-11-03T23:10:00Z`.
//  - Columns: activeSince email, last_seen, last_url (nullable), person_id;
//    pageviewCounts email, pageviews_30d; latestEvents event, url (nullable), timestamp,
//    person_id; healthProbe persons_with_email.
//  - Profile URL: `${host}/project/${projectId}/persons/${encodeURIComponent(person_id)}`.
//
// The spike texts are used verbatim, except where this story's bytes fence requires the
// caller's window: pageviewCounts and latestEvents bind `timestamp >= {since}` in place of
// `now() - INTERVAL n DAY`, and latestEvents binds `LIMIT {limit}` in place of `LIMIT 20`.
//
// The module is loaded at runtime by absolute path so this file compiles before it exists.
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type Built = { query: string; values: Record<string, unknown> };
type Result = { columns: string[]; results: unknown[][] };

const load = async (): Promise<Record<string, any>> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/queries.ts'));

const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-04T00:00:00.000Z');
const SINCE = new Date('2026-10-05T00:00:00.000Z');
const UNTIL = new Date('2026-11-03T23:50:00.000Z');
const PERSON_ID = '8bd558e6-1f3a-4c2e-9d7b-0a1b2c3d4e5f';
const HOSTILE_EMAIL = "o'brien)--@x.com";

const SQL = {
  activeSince:
    "SELECT lower(person.properties.email) AS email, max(timestamp) AS last_seen, argMaxIf(properties.$current_url, timestamp, event = '$pageview') AS last_url, argMax(person_id, timestamp) AS person_id FROM events WHERE timestamp >= {since} AND timestamp < {until} AND notEmpty(person.properties.email) GROUP BY email ORDER BY last_seen ASC LIMIT {limit}",
  pageviewCounts:
    "SELECT lower(p.properties.email) AS email, coalesce(sum(c.pageviews), 0) AS pageviews_30d FROM persons AS p LEFT JOIN (SELECT person_id, uniqExact(uuid) AS pageviews FROM events WHERE event = '$pageview' AND timestamp >= {since} GROUP BY person_id) AS c ON c.person_id = p.id WHERE lower(p.properties.email) IN {emails} GROUP BY email ORDER BY email LIMIT {limit}",
  latestEvents:
    'SELECT event, properties.$current_url AS url, timestamp, person_id FROM events WHERE lower(person.properties.email) = {email} AND timestamp >= {since} ORDER BY timestamp DESC LIMIT 1 BY uuid LIMIT {limit}',
  healthProbe:
    'SELECT count() AS persons_with_email FROM persons WHERE notEmpty(properties.email)',
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// The value bound to the `timestamp >= {x}` lower bound, as epoch ms.
const timestampLowerBound = ({ query, values }: Built): number => {
  const match = query.match(/timestamp\s*>=\s*\{(\w+)\}/);
  expect(match, `no bound timestamp lower bound in: ${query}`).not.toBeNull();
  const bound = values[match![1]];
  expect(typeof bound).toBe('string');
  return Date.parse(bound as string);
};

// The value of the query's final LIMIT, bound or literal.
const finalLimit = ({ query, values }: Built): unknown => {
  const match = query.match(/LIMIT\s+(?:\{(\w+)\}|(\d+))\s*$/);
  expect(match, `no final LIMIT in: ${query}`).not.toBeNull();
  return match![1] ? values[match![1]] : Number(match![2]);
};

describe('TCA-24 query builders', () => {
  it('build the spike-recorded HogQL with every value bound through `values`', async () => {
    const q = await load();

    const active: Built = q.activeSinceQuery({ since: SINCE, until: UNTIL, limit: 5000 });
    expect(active.query).toBe(SQL.activeSince);
    expect(Object.keys(active.values).sort()).toEqual(['limit', 'since', 'until']);
    expect(Date.parse(active.values.since as string)).toBe(SINCE.getTime());
    expect(Date.parse(active.values.until as string)).toBe(UNTIL.getTime());
    expect(active.values.limit).toBe(5000);

    const counts: Built = q.pageviewCountsQuery({ emails: ['a@x.com', 'b@x.com'], now: NOW });
    expect(counts.query).toBe(SQL.pageviewCounts);
    expect(counts.values.emails).toEqual(['a@x.com', 'b@x.com']);
    // Spike: LIMIT must be at least the list length, or rows are silently cut.
    expect(counts.values.limit).toBeGreaterThanOrEqual(2);
    expect(counts.values.limit).toBeLessThanOrEqual(50_000);

    const latest: Built = q.latestEventsQuery({ email: 'a@x.com', now: NOW });
    expect(latest.query).toBe(SQL.latestEvents);
    expect(latest.values.email).toBe('a@x.com');

    const probe: Built = q.healthProbeQuery();
    expect(probe).toEqual({ query: SQL.healthProbe, values: {} });
  });

  it('trim, lowercase and de-duplicate emails before binding; an empty email list throws', async () => {
    const q = await load();

    const counts: Built = q.pageviewCountsQuery({
      emails: [' Chesky@Airbnb.com ', 'chesky@airbnb.com', 'ZHAO@notion.com', 'zhao@NOTION.com  '],
      now: NOW,
    });
    expect([...(counts.values.emails as string[])].sort()).toEqual([
      'chesky@airbnb.com',
      'zhao@notion.com',
    ]);

    const latest: Built = q.latestEventsQuery({ email: '  Chesky@Airbnb.COM ', now: NOW });
    expect(latest.values.email).toBe('chesky@airbnb.com');

    expect(() => q.pageviewCountsQuery({ emails: [], now: NOW })).toThrow();
    expect(() => q.pageviewCountsQuery({ emails: ['   ', ''], now: NOW })).toThrow();
  });

  it('injection fence: a different (hostile) email or window changes only `values`, never `query`', async () => {
    const q = await load();

    const countsA: Built = q.pageviewCountsQuery({ emails: ['a@x.com'], now: NOW });
    const countsB: Built = q.pageviewCountsQuery({ emails: [HOSTILE_EMAIL], now: NOW });
    expect(countsB.query).toBe(countsA.query);
    expect(countsB.query).not.toContain('brien');
    expect(countsB.values.emails).toEqual([HOSTILE_EMAIL]);

    const latestA: Built = q.latestEventsQuery({ email: 'a@x.com', now: NOW });
    const latestB: Built = q.latestEventsQuery({ email: HOSTILE_EMAIL, now: NOW });
    expect(latestB.query).toBe(latestA.query);
    expect(latestB.query).not.toContain('brien');
    expect(latestB.values.email).toBe(HOSTILE_EMAIL);

    // Windows and limits are bound too, so no caller input reaches the query text.
    const latestC: Built = q.latestEventsQuery({ email: 'a@x.com', now: UNTIL, limit: 5, days: 7 });
    expect(latestC.query).toBe(latestA.query);
    const activeA: Built = q.activeSinceQuery({ since: SINCE, until: UNTIL, limit: 10 });
    const activeB: Built = q.activeSinceQuery({ since: UNTIL, until: NOW, limit: 20 });
    expect(activeB.query).toBe(activeA.query);
  });

  it("bytes fence: every events query binds a timestamp lower bound equal to the caller's window, and keeps a LIMIT", async () => {
    const q = await load();

    const active: Built = q.activeSinceQuery({ since: SINCE, until: UNTIL, limit: 5000 });
    expect(timestampLowerBound(active)).toBe(SINCE.getTime());
    expect(finalLimit(active)).toBe(5000);

    const counts: Built = q.pageviewCountsQuery({ emails: ['a@x.com'], now: NOW });
    expect(timestampLowerBound(counts)).toBe(NOW.getTime() - 30 * DAY_MS);
    expect(finalLimit(counts)).toBeGreaterThanOrEqual(1);

    const latestDefault: Built = q.latestEventsQuery({ email: 'a@x.com', now: NOW });
    expect(timestampLowerBound(latestDefault)).toBe(NOW.getTime() - 90 * DAY_MS);
    expect(finalLimit(latestDefault)).toBe(20);

    const latestCustom: Built = q.latestEventsQuery({ email: 'a@x.com', now: NOW, limit: 5, days: 7 });
    expect(timestampLowerBound(latestCustom)).toBe(NOW.getTime() - 7 * DAY_MS);
    expect(finalLimit(latestCustom)).toBe(5);

    // The window is the caller's clock, not PostHog's.
    for (const built of [active, counts, latestDefault]) expect(built.query).not.toMatch(/now\(\)/i);
  });
});

describe('TCA-24 row parsers', () => {
  it('read rows by column name, keep null URLs, and return ISO 8601 UTC timestamps', async () => {
    const q = await load();

    // Columns deliberately out of query order: a positional parser gets these wrong.
    const active = q.parseActiveRows({
      columns: ['person_id', 'last_url', 'email', 'last_seen'],
      results: [
        [PERSON_ID, '/app/dashboard', 'chesky@airbnb.com', '2026-11-03T23:10:00Z'],
        [PERSON_ID, null, 'zhao@notion.com', '2026-11-04T01:10:00+02:00'],
      ],
    } satisfies Result);
    expect(active).toEqual([
      { email: 'chesky@airbnb.com', lastSeenAt: expect.stringMatching(ISO_UTC), lastUrl: '/app/dashboard', personRef: PERSON_ID },
      { email: 'zhao@notion.com', lastSeenAt: expect.stringMatching(ISO_UTC), lastUrl: null, personRef: PERSON_ID },
    ]);
    expect(Date.parse(active[0].lastSeenAt)).toBe(Date.parse('2026-11-03T23:10:00Z'));
    expect(Date.parse(active[1].lastSeenAt)).toBe(Date.parse('2026-11-03T23:10:00Z'));

    const counts: Map<string, number> = q.parsePageviewCounts({
      columns: ['pageviews_30d', 'email'],
      results: [
        [5, 'chesky@airbnb.com'],
        [0, 'zhao@notion.com'],
      ],
    } satisfies Result);
    expect(counts).toBeInstanceOf(Map);
    expect([...counts.entries()].sort()).toEqual([
      ['chesky@airbnb.com', 5],
      ['zhao@notion.com', 0],
    ]);

    const events = q.parseLatestEvents({
      columns: ['timestamp', 'person_id', 'url', 'event'],
      results: [
        ['2026-11-03T23:10:00Z', PERSON_ID, null, 'report_exported'],
        ['2026-11-03T22:00:00Z', PERSON_ID, '/app/dashboard', '$pageview'],
      ],
    } satisfies Result);
    expect(events).toEqual([
      { event: 'report_exported', url: null, timestamp: expect.stringMatching(ISO_UTC), personRef: PERSON_ID },
      { event: '$pageview', url: '/app/dashboard', timestamp: expect.stringMatching(ISO_UTC), personRef: PERSON_ID },
    ]);
    expect(Date.parse(events[1].timestamp)).toBe(Date.parse('2026-11-03T22:00:00Z'));

    expect(q.parseHealthProbe({ columns: ['persons_with_email'], results: [[6]] } satisfies Result)).toBe(6);
  });

  it.each([
    ['parseActiveRows', ['email', 'last_seen', 'person_id'], 'last_url'],
    ['parsePageviewCounts', ['email'], 'pageviews_30d'],
    ['parseLatestEvents', ['event', 'url', 'person_id'], 'timestamp'],
    ['parseHealthProbe', ['count'], 'persons_with_email'],
  ])('%s throws an error naming a missing column (%s present, %s absent)', async (parser, columns, missing) => {
    const q = await load();
    const result: Result = { columns, results: [columns.map(() => null)] };
    expect(() => q[parser](result)).toThrow(missing);
  });
});

describe('TCA-24 profileUrl', () => {
  it('builds the PostHog person page URL from host, project id and person_id', async () => {
    const q = await load();
    expect(q.profileUrl('https://us.posthog.com', '12345', PERSON_ID)).toBe(
      `https://us.posthog.com/project/12345/persons/${PERSON_ID}`,
    );
    expect(q.profileUrl('https://eu.posthog.com', '7', 'a b/c')).toBe(
      'https://eu.posthog.com/project/7/persons/a%20b%2Fc',
    );
  });
});

// Shape only. Consumers: TCA-26 (healthProbeQuery, parseHealthProbe), TCA-28 (latestEventsQuery,
// parseLatestEvents, profileUrl), TCA-29 (activeSinceQuery, pageviewCountsQuery, parsers,
// profileUrl), TCA-30 (pageviewCountsQuery, parsePageviewCounts).
describe('TCA-24 contract for TCA-26, TCA-28, TCA-29 and TCA-30', () => {
  it('exports the four builders, four parsers and profileUrl with the promised shapes', async () => {
    const q = await load();
    const names = [
      'activeSinceQuery',
      'pageviewCountsQuery',
      'latestEventsQuery',
      'healthProbeQuery',
      'parseActiveRows',
      'parsePageviewCounts',
      'parseLatestEvents',
      'parseHealthProbe',
      'profileUrl',
    ];
    for (const n of names) expect(typeof q[n], n).toBe('function');

    const builtShape = { query: expect.any(String), values: expect.any(Object) };
    expect(q.activeSinceQuery({ since: SINCE, until: UNTIL, limit: 1 })).toEqual(builtShape);
    expect(q.pageviewCountsQuery({ emails: ['a@x.com'], now: NOW })).toEqual(builtShape);
    expect(q.latestEventsQuery({ email: 'a@x.com', now: NOW })).toEqual(builtShape);
    expect(q.healthProbeQuery()).toEqual(builtShape);

    const [row] = q.parseActiveRows({
      columns: ['email', 'last_seen', 'last_url', 'person_id'],
      results: [['a@x.com', '2026-11-03T23:10:00Z', null, PERSON_ID]],
    });
    expect(Object.keys(row).sort()).toEqual(['email', 'lastSeenAt', 'lastUrl', 'personRef']);
    expect(typeof row.lastSeenAt).toBe('string');

    expect(q.parsePageviewCounts({ columns: ['email', 'pageviews_30d'], results: [['a@x.com', 1]] })).toBeInstanceOf(Map);

    const [event] = q.parseLatestEvents({
      columns: ['event', 'url', 'timestamp', 'person_id'],
      results: [['$pageview', null, '2026-11-03T23:10:00Z', PERSON_ID]],
    });
    expect(Object.keys(event).sort()).toEqual(['event', 'personRef', 'timestamp', 'url']);

    expect(typeof q.parseHealthProbe({ columns: ['persons_with_email'], results: [[0]] })).toBe('number');
    expect(typeof q.profileUrl('https://us.posthog.com', '1', PERSON_ID)).toBe('string');
  });
});
