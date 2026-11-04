// TCA-24 red-phase tests: HogQL builders, row parsers and profileUrl in src/lib/queries.ts.
//
// External facts (no DB tables involved; PostHog API shapes only):
//  - Query texts, `values` names and response columns: docs/decisions/D-TCA-22-posthog-api-shapes.md.
//    activeSince (text 1) and healthProbe (text 4) are verbatim. pageviewCounts (text 2) and
//    latestEvents (text 3) bind `timestamp >= {since}` from the caller's `now` instead of
//    `now() - INTERVAL n DAY`, and latestEvents binds `LIMIT {limit}` instead of `LIMIT 20`
//    (D-TCA-24-caller-clock-windows, written in this story's PR, supersedes D-TCA-22's TCA-24 line).
//  - Response columns (D-TCA-22): activeSince email, last_seen, last_url (nullable), person_id;
//    pageviewCounts email, pageviews_30d; latestEvents event, url (nullable), timestamp, person_id;
//    healthProbe persons_with_email. DateTime64 comes back as e.g. 2026-11-03T23:10:00Z.
//  - PostHog clamps any LIMIT above 50,000 silently (D-TCA-22 observation 2), hence the cap.
//  - Parsers take TCA-23's runQuery result shape ({ columns, results }, plus bytesRead).
//
// Pinned contract for /implement (all exported from src/lib/queries.ts):
//  activeSinceQuery({ since, until, limit }), pageviewCountsQuery({ emails, now }),
//  latestEventsQuery({ email, now, limit = 20, days = 90 }), healthProbeQuery()
//    -> { query: string; values: Record<string, unknown> }
//  parseActiveRows, parsePageviewCounts, parseLatestEvents, parseHealthProbe, profileUrl.
//
// The module is loaded at runtime by absolute path so this file compiles before it exists.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type BuiltQuery = { query: string; values: Record<string, unknown> };
type QueryRows = { columns: string[]; results: unknown[][] };
type ActiveRow = { email: string; lastSeenAt: string; lastUrl: string | null; personRef: string };
type LatestEvent = { event: string; url: string | null; timestamp: string; personRef: string };
type QueriesModule = {
  activeSinceQuery: (input: { since: Date; until: Date; limit: number }) => BuiltQuery;
  pageviewCountsQuery: (input: { emails: string[]; now: Date }) => BuiltQuery;
  latestEventsQuery: (input: {
    email: string;
    now: Date;
    limit?: number;
    days?: number;
  }) => BuiltQuery;
  healthProbeQuery: () => BuiltQuery;
  parseActiveRows: (rows: QueryRows) => ActiveRow[];
  parsePageviewCounts: (rows: QueryRows) => Map<string, number>;
  parseLatestEvents: (rows: QueryRows) => LatestEvent[];
  parseHealthProbe: (rows: QueryRows) => number;
  profileUrl: (host: string, projectId: string, personRef: string) => string;
};

const loadQueries = async (): Promise<QueriesModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/queries.ts'));

const SQL = {
  activeSince:
    "SELECT lower(person.properties.email) AS email, max(timestamp) AS last_seen, argMaxIf(properties.$current_url, timestamp, event = '$pageview') AS last_url, argMax(person_id, timestamp) AS person_id FROM events WHERE timestamp >= {since} AND timestamp < {until} AND notEmpty(person.properties.email) GROUP BY email ORDER BY last_seen ASC LIMIT {limit}",
  pageviewCounts:
    "SELECT lower(p.properties.email) AS email, coalesce(sum(c.pageviews), 0) AS pageviews_30d FROM persons AS p LEFT JOIN (SELECT person_id, uniqExact(uuid) AS pageviews FROM events WHERE event = '$pageview' AND timestamp >= {since} GROUP BY person_id) AS c ON c.person_id = p.id WHERE lower(p.properties.email) IN {emails} GROUP BY email ORDER BY email LIMIT {limit}",
  latestEvents:
    'SELECT event, properties.$current_url AS url, timestamp, person_id FROM events WHERE lower(person.properties.email) = {email} AND timestamp >= {since} ORDER BY timestamp DESC LIMIT 1 BY uuid LIMIT {limit}',
  healthProbe: 'SELECT count() AS persons_with_email FROM persons WHERE notEmpty(properties.email)',
};

const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-04T00:00:00.000Z');
const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const INJECTION_EMAIL = "o'brien)--@x.com";

const emailList = (count: number) => Array.from({ length: count }, (_, i) => `user${i}@x.com`);

// Asserts a timestamp is an ISO 8601 UTC string for the given instant.
const expectUtcIso = (actual: string, instant: string) => {
  expect(actual).toMatch(UTC_ISO);
  expect(Date.parse(actual)).toBe(Date.parse(instant));
};

describe('contract for TCA-26, TCA-28, TCA-29 and TCA-30 (shape only)', () => {
  it('exports every promised builder, parser and profileUrl with the promised shapes', async () => {
    const q = await loadQueries();

    for (const name of [
      'activeSinceQuery',
      'pageviewCountsQuery',
      'latestEventsQuery',
      'healthProbeQuery',
      'parseActiveRows',
      'parsePageviewCounts',
      'parseLatestEvents',
      'parseHealthProbe',
      'profileUrl',
    ] as const) {
      expect(typeof q[name], name).toBe('function');
    }

    const built = [
      q.activeSinceQuery({ since: new Date(daysBefore(NOW, 1)), until: NOW, limit: 10 }),
      q.pageviewCountsQuery({ emails: ['a@x.com'], now: NOW }),
      q.latestEventsQuery({ email: 'a@x.com', now: NOW }),
      q.latestEventsQuery({ email: 'a@x.com', now: NOW, limit: 5, days: 7 }),
      q.healthProbeQuery(),
    ];
    for (const b of built) {
      expect(typeof b.query).toBe('string');
      expect(typeof b.values).toBe('object');
      expect(b.values).not.toBeNull();
    }

    const active = q.parseActiveRows({
      columns: ['email', 'last_seen', 'last_url', 'person_id'],
      results: [['a@x.com', '2026-11-03T23:10:00Z', null, 'p-1']],
    });
    expect(Array.isArray(active)).toBe(true);
    expect(typeof active[0].email).toBe('string');
    expect(typeof active[0].lastSeenAt).toBe('string');
    expect(active[0].lastUrl).toBeNull();
    expect(typeof active[0].personRef).toBe('string');

    const counts = q.parsePageviewCounts({
      columns: ['email', 'pageviews_30d'],
      results: [['a@x.com', 3]],
    });
    expect(counts).toBeInstanceOf(Map);
    expect(typeof counts.get('a@x.com')).toBe('number');

    const events = q.parseLatestEvents({
      columns: ['event', 'url', 'timestamp', 'person_id'],
      results: [['$pageview', '/a', '2026-11-03T23:10:00Z', 'p-1']],
    });
    expect(Object.keys(events[0]).sort()).toEqual(['event', 'personRef', 'timestamp', 'url']);
    expect(typeof events[0].url).toBe('string');

    expect(
      typeof q.parseHealthProbe({ columns: ['persons_with_email'], results: [[6]] }),
    ).toBe('number');
    expect(typeof q.profileUrl('https://us.posthog.com', '1', 'p-1')).toBe('string');
  });
});

describe('query builders', () => {
  it('use the D-TCA-22 texts, with caller-clock windows for pageviewCounts and latestEvents', async () => {
    const q = await loadQueries();

    expect(q.activeSinceQuery({ since: NOW, until: NOW, limit: 1 }).query).toBe(SQL.activeSince);
    expect(q.pageviewCountsQuery({ emails: ['a@x.com'], now: NOW }).query).toBe(
      SQL.pageviewCounts,
    );
    expect(q.latestEventsQuery({ email: 'a@x.com', now: NOW }).query).toBe(SQL.latestEvents);
    expect(q.healthProbeQuery()).toEqual({ query: SQL.healthProbe, values: {} });

    for (const built of [
      q.activeSinceQuery({ since: NOW, until: NOW, limit: 1 }),
      q.pageviewCountsQuery({ emails: ['a@x.com'], now: NOW }),
      q.latestEventsQuery({ email: 'a@x.com', now: NOW }),
    ]) {
      expect(built.query).not.toMatch(/now\(\)/i);
    }
  });

  it('activeSinceQuery binds since, until and limit as ISO strings and an integer', async () => {
    const q = await loadQueries();
    const since = new Date('2026-11-03T22:00:00.000Z');
    const until = new Date('2026-11-03T23:50:00.000Z');

    expect(q.activeSinceQuery({ since, until, limit: 5000 }).values).toEqual({
      since: '2026-11-03T22:00:00.000Z',
      until: '2026-11-03T23:50:00.000Z',
      limit: 5000,
    });
  });

  it('pageviewCountsQuery trims, lowercases and de-duplicates emails; limit is the list length', async () => {
    const q = await loadQueries();

    const built = q.pageviewCountsQuery({
      emails: ['  Chesky@Airbnb.com ', 'chesky@airbnb.com', 'ZHAO@Notion.com', 'zhao@notion.com  '],
      now: NOW,
    });

    expect(built.values).toEqual({
      emails: ['chesky@airbnb.com', 'zhao@notion.com'],
      since: daysBefore(NOW, 30),
      limit: 2,
    });
  });

  it('pageviewCountsQuery throws on an empty list, before or after normalising', async () => {
    const q = await loadQueries();

    expect(() => q.pageviewCountsQuery({ emails: [], now: NOW })).toThrow(Error);
    expect(() => q.pageviewCountsQuery({ emails: ['   ', ''], now: NOW })).toThrow(Error);
  });

  it('latestEventsQuery normalises the email and defaults to 20 rows over 90 days', async () => {
    const q = await loadQueries();

    expect(q.latestEventsQuery({ email: '  Chesky@Airbnb.COM ', now: NOW }).values).toEqual({
      email: 'chesky@airbnb.com',
      since: daysBefore(NOW, 90),
      limit: 20,
    });
    expect(
      q.latestEventsQuery({ email: 'chesky@airbnb.com', now: NOW, limit: 5, days: 7 }).values,
    ).toEqual({ email: 'chesky@airbnb.com', since: daysBefore(NOW, 7), limit: 5 });
  });
});

describe('bytes fence: every events query is bounded by a bound timestamp from the caller', () => {
  it('binds the lower bound to the caller since, now - 30 days, or now - days', async () => {
    const q = await loadQueries();
    const since = new Date('2026-10-01T12:00:00.000Z');

    const cases: [BuiltQuery, string, string][] = [
      [q.activeSinceQuery({ since, until: NOW, limit: 10 }), 'since', since.toISOString()],
      [q.pageviewCountsQuery({ emails: ['a@x.com'], now: NOW }), 'since', daysBefore(NOW, 30)],
      [q.latestEventsQuery({ email: 'a@x.com', now: NOW }), 'since', daysBefore(NOW, 90)],
      [
        q.latestEventsQuery({ email: 'a@x.com', now: NOW, days: 14 }),
        'since',
        daysBefore(NOW, 14),
      ],
    ];

    for (const [built, name, expected] of cases) {
      expect(built.query).toContain(`timestamp >= {${name}}`);
      expect(built.query).not.toMatch(/now\(\)/i);
      expect(built.values[name]).toBe(expected);
    }
  });
});

describe('injection fence: values never reach the query text', () => {
  it('produces identical query strings for different emails, clocks and limits', async () => {
    const q = await loadQueries();
    const later = new Date('2027-02-14T09:30:00.000Z');

    const pv1 = q.pageviewCountsQuery({ emails: ['a@x.com'], now: NOW });
    const pv2 = q.pageviewCountsQuery({ emails: [INJECTION_EMAIL, 'b@y.com'], now: later });
    expect(pv2.query).toBe(pv1.query);
    expect(pv2.values.emails).toEqual([INJECTION_EMAIL, 'b@y.com']);

    const le1 = q.latestEventsQuery({ email: 'a@x.com', now: NOW });
    const le2 = q.latestEventsQuery({ email: INJECTION_EMAIL, now: later, limit: 7, days: 3 });
    expect(le2.query).toBe(le1.query);
    expect(le2.values.email).toBe(INJECTION_EMAIL);

    const as1 = q.activeSinceQuery({ since: NOW, until: later, limit: 1 });
    const as2 = q.activeSinceQuery({ since: later, until: later, limit: 49_999 });
    expect(as2.query).toBe(as1.query);

    for (const built of [pv2, le2, as2]) {
      expect(built.query).not.toContain('brien');
      expect(built.query).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});

describe('limit cap: integer 1..50,000, else RangeError', () => {
  it('accepts 50,000 and rejects 50,001, 0 and 1.5 for activeSince and latestEvents', async () => {
    const q = await loadQueries();

    expect(q.activeSinceQuery({ since: NOW, until: NOW, limit: 50_000 }).values.limit).toBe(50_000);
    expect(q.latestEventsQuery({ email: 'a@x.com', now: NOW, limit: 50_000 }).values.limit).toBe(
      50_000,
    );

    for (const limit of [50_001, 0, 1.5]) {
      expect(() => q.activeSinceQuery({ since: NOW, until: NOW, limit }), `${limit}`).toThrow(
        RangeError,
      );
      expect(() => q.latestEventsQuery({ email: 'a@x.com', now: NOW, limit }), `${limit}`).toThrow(
        RangeError,
      );
    }
  });

  it('pageviewCountsQuery builds for 50,000 distinct emails and throws RangeError for 50,001', async () => {
    const q = await loadQueries();

    expect(q.pageviewCountsQuery({ emails: emailList(50_000), now: NOW }).values.limit).toBe(
      50_000,
    );
    expect(() => q.pageviewCountsQuery({ emails: emailList(50_001), now: NOW })).toThrow(RangeError);
  });
});

describe('row parsers read by column name', () => {
  it('parseActiveRows maps columns to typed rows with UTC ISO timestamps and a null lastUrl', async () => {
    const q = await loadQueries();

    const rows = q.parseActiveRows({
      columns: ['person_id', 'last_url', 'email', 'last_seen'],
      results: [
        ['018f-a', '/app/dashboard', 'chesky@airbnb.com', '2026-11-03T23:10:00Z'],
        ['018f-b', null, 'zhao@notion.com', '2026-11-03T18:15:00-05:00'],
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      email: 'chesky@airbnb.com',
      lastUrl: '/app/dashboard',
      personRef: '018f-a',
    });
    expect(rows[1]).toMatchObject({ email: 'zhao@notion.com', lastUrl: null, personRef: '018f-b' });
    expectUtcIso(rows[0].lastSeenAt, '2026-11-03T23:10:00Z');
    expectUtcIso(rows[1].lastSeenAt, '2026-11-03T23:15:00Z');
  });

  it('parsePageviewCounts returns a Map from lowercased email to count, including zero', async () => {
    const q = await loadQueries();

    const counts = q.parsePageviewCounts({
      columns: ['pageviews_30d', 'email'],
      results: [
        [5, 'chesky@airbnb.com'],
        [0, 'zhao@notion.com'],
      ],
    });

    expect(counts).toEqual(
      new Map([
        ['chesky@airbnb.com', 5],
        ['zhao@notion.com', 0],
      ]),
    );
    expect(counts.has('nobody@example.com')).toBe(false);
  });

  it('parseLatestEvents keeps row order (newest first) with null urls and UTC ISO timestamps', async () => {
    const q = await loadQueries();

    const events = q.parseLatestEvents({
      columns: ['timestamp', 'person_id', 'url', 'event'],
      results: [
        ['2026-11-03T23:10:00Z', '018f-a', null, 'report_exported'],
        ['2026-11-03T18:00:00-05:00', '018f-a', '/app/dashboard', '$pageview'],
      ],
    });

    expect(events.map(({ event, url, personRef }) => ({ event, url, personRef }))).toEqual([
      { event: 'report_exported', url: null, personRef: '018f-a' },
      { event: '$pageview', url: '/app/dashboard', personRef: '018f-a' },
    ]);
    expectUtcIso(events[0].timestamp, '2026-11-03T23:10:00Z');
    expectUtcIso(events[1].timestamp, '2026-11-03T23:00:00Z');
  });

  it('parseHealthProbe returns persons_with_email as a number', async () => {
    const q = await loadQueries();

    expect(q.parseHealthProbe({ columns: ['persons_with_email'], results: [[6]] })).toBe(6);
    expect(
      q.parseHealthProbe({ columns: ['extra', 'persons_with_email'], results: [[99, 0]] }),
    ).toBe(0);
  });

  it('throws an error naming the column when an expected column is missing', async () => {
    const q = await loadQueries();

    expect(() =>
      q.parseActiveRows({
        columns: ['email', 'last_seen', 'person_id'],
        results: [['a@x.com', '2026-11-03T23:10:00Z', 'p']],
      }),
    ).toThrow(/last_url/);
    expect(() =>
      q.parsePageviewCounts({ columns: ['email'], results: [['a@x.com']] }),
    ).toThrow(/pageviews_30d/);
    expect(() =>
      q.parseLatestEvents({
        columns: ['event', 'url', 'timestamp'],
        results: [['$pageview', null, '2026-11-03T23:10:00Z']],
      }),
    ).toThrow(/person_id/);
    expect(() => q.parseHealthProbe({ columns: ['count'], results: [[6]] })).toThrow(
      /persons_with_email/,
    );
  });
});

describe('profileUrl', () => {
  it('builds {host}/project/{projectId}/persons/{encoded personRef}', async () => {
    const q = await loadQueries();

    expect(
      q.profileUrl('https://us.posthog.com', '12345', '8bd558e6-0000-4000-8000-000000000001'),
    ).toBe('https://us.posthog.com/project/12345/persons/8bd558e6-0000-4000-8000-000000000001');
    expect(q.profileUrl('https://ph.example.com', '7', 'a/b c?d')).toBe(
      'https://ph.example.com/project/7/persons/a%2Fb%20c%3Fd',
    );
  });
});

describe('decision records', () => {
  const read = (name: string) =>
    readFileSync(resolve(process.cwd(), 'docs/decisions', name), 'utf8');

  it('D-TCA-24-caller-clock-windows exists and D-TCA-22 points its TCA-24 line to it', () => {
    const d24 = read('D-TCA-24-caller-clock-windows.md');
    expect(d24).toMatch(/^\*\*Status:\*\* .+/m);
    expect(d24).toContain('D-TCA-22');
    expect(d24).toMatch(/supersede/i);

    const d22 = read('D-TCA-22-posthog-api-shapes.md');
    expect(d22).toMatch(
      /^\*\*Status:\*\* Accepted; partly superseded by D-TCA-24-caller-clock-windows \(.+\)$/m,
    );
    const tca24Impact = d22.match(/^- \*\*TCA-24 \(queries\):\*\*[\s\S]*?(?=^- \*\*TCA-26)/m)?.[0];
    expect(tca24Impact).toContain('D-TCA-24');
  });
});
