# D-TCA-22: Confirmed PostHog query shapes, error matrix and Twenty write method
**Status:** Accepted; partly superseded by D-TCA-24-caller-clock-windows (pageviewCounts and latestEvents texts, profile URL host)
**Date:** 2026-11-04
**Issue:** TCA-22
**Confluence:** none

**Decision:** The app talks to PostHog with four fixed HogQL queries (texts below; two shipped as
amended by D-TCA-24-caller-clock-windows) posted to
`{host}/api/projects/{id}/query/` with `refresh: 'force_blocking'`, every value bound through
`values` and every query carrying an explicit `LIMIT`. Errors map to kinds by HTTP status plus
the body's `code` and `detail`. The health check uses only the HogQL probe. Profile links are
`{host}/project/{projectId}/persons/{person_id}`. Twenty writes use
`createPeople(data, upsert: true)` with `{ id, <changed fields> }`, restricted to ids read in the
same run.

**Why:** Every point was observed on 2026-11-04 against a seeded PostHog Cloud US project and the
demo workspace `lead-scoring.twenty.com`, except the rows marked "from docs, not observed". Four
observations contradict what the PRD or Epic assumed:

1. `refresh: 'blocking'` returned a cached result (`is_cached: true`, no bytes-read header) for a
   repeated query after new events had landed. `force_blocking` always recomputed.
2. A query without `LIMIT` is silently rewritten to `LIMIT 101` and returns 100 rows with
   `hasMore: true`. A `LIMIT` above 50,000 is clamped to 50,000 with `hasMore: null`, so
   truncation is invisible.
3. Event dedupe on `uuid` is asynchronous. After re-sending the same 60 events, `count()` read
   90, then 89, then 76, and was still 76 nine minutes after the rerun, while `uniqExact(uuid)`
   stayed 60. `count()` over events overcounts until ClickHouse merges the copies in the
   background, at a time nothing in the API exposes.
4. A bad personal key returns **403** `authentication_failed`, not 401. A `query:read`-only key
   gets 403 on `GET /api/projects/{id}/` (`API key missing required scope 'project:read'`).

On the Twenty side, upsert by id updates in place and leaves omitted fields alone, but it also
creates a blank Person for an unknown id and restores a soft-deleted Person (details below).

**Rejected:**
- `refresh: 'blocking'`: serves stale cached results (observation 1); the widget would miss
  fresh events and the cursor-based sync gains nothing from the cache.
- `count()` for page views: overcounts after any duplicate ingest (observation 3).
- `persons LEFT JOIN events` with the 30-day filter inside `countIf`: same rows, but it scans all
  events for the persons (1,257,608 bytes vs 896,595 for the pre-aggregated subquery on the same
  emails).
- `GET /api/projects/{id}/` in the health check: 403 on every correctly scoped key.
- `updatePerson` per row: refuses unknown ids (`NOT_FOUND`) and never restores a soft-deleted
  Person, but costs one request per changed person instead of one per 200. The upsert hazards
  only bite when a Person is deleted between the job's own read and its write, a window of
  seconds, so the batched upsert stays.

**Impact:**
- **TCA-23 (client):** POST `{host}/api/projects/{projectId}/query/`, header
  `Authorization: Bearer <key>`, body
  `{ query: { kind: 'HogQLQuery', query, values }, refresh: 'force_blocking' }`. Read `columns`,
  `types` and `results` (row arrays in `columns` order) from a 200. Map errors exactly as the
  *Error matrix* below: 401 or 403 with `code` `authentication_failed` / `not_authenticated` ->
  `unauthorized`; 403 `permission_denied` whose `detail` starts with `API key missing required
  scope` -> `missing_scope`; 403 `permission_denied` with `does not have access to the requested
  project`, or 404 -> `project_not_found`; 429 (any code) -> `rate_limited` carrying
  `Retry-After`; 504 -> `timeout`; 400 -> `bad_query`; fetch rejection -> `unreachable`; other
  5xx -> `server_error`. Never treat 403 as missing scope by status alone. Never log the key.
- **TCA-24 (queries):** use the four query texts below verbatim, with the listed `values` names
  and types. Lowercase emails before binding them. Every query keeps an explicit `LIMIT`; the
  caller's limit must be at most 50,000. Page-view counts use `uniqExact(uuid)`, never `count()`.
  The profile URL builder is
  `` `${appHost}/project/${projectId}/persons/${encodeURIComponent(person_id)}` `` where
  `appHost` is the configured `POSTHOG_HOST` (the app host, not the `.i.` ingestion host) and
  `person_id` is the column of that name from activeSince or latestEvents.
  Superseded for the pageviewCounts and latestEvents texts by D-TCA-24-caller-clock-windows,
  which binds their window from the caller's `now` and latestEvents' `LIMIT {limit}`. Also
  superseded there: `appHost` is `readSettings().host`, which is `POSTHOG_CUSTOM_HOST` when
  `POSTHOG_HOST` is `custom` (the stored value `custom` is not a host).
- **TCA-26 (health check):** only the healthProbe query; no `GET /api/projects/{id}/`. A wrong
  region surfaces as `unauthorized` (the key is unknown in the other region), so its message must
  mention the host setting.
- **TCA-27 (writer):** `createPeople(data: [...], upsert: true)` with `{ id, <changed fields> }`,
  only for ids returned by a Twenty read in the same job run (never ids from KV, PostHog or an
  earlier run). Send LINKS fields as the full composite
  `{ primaryLinkUrl, primaryLinkLabel, secondaryLinks }`; clear a LINKS field with
  `{ primaryLinkUrl: '', primaryLinkLabel: '', secondaryLinks: [] }` (`null` is ignored); clear
  DATE_TIME and NUMBER with `null`.

## Evidence

Seeded with `scripts/seed-posthog.sh` (60 events, 6 people, anchor 2026-11-04T00:00Z). Each
person: two anonymous `$pageview`s 21+i days ago, `$identify`, `signup_completed`, five
identified `$pageview`s (38 and 33 days ago, then 10+i days, 3+i days, 2i+1 hours), and a later
`report_exported`. Expected 30-day page views per person: 5 (2 anonymous + 3 identified).

### Request and response shape

- `values` placeholders are `{name}` in the query text. Scalars, ISO strings (with or without
  milliseconds, `Z` suffix) and integers (`LIMIT {limit}`) bind; a JSON array binds to
  `IN {emails}` (500-element list: no error). The resolved query is echoed in the response's
  `hogql` field with values inlined as escaped literals.
- 200 body keys used: `columns` (string[]), `types` ([name, ClickHouse type][]), `results`
  (row arrays), `hasMore`, `is_cached`, `error` (null on success).
- Headers on every computed (non-cached) response: `X-PostHog-Query-Bytes-Read`,
  `X-PostHog-Query-Budget-Remaining-Bytes` (about 4.8e11 on this project).
- DateTime64 values come back as `2026-11-03T23:10:00Z`.

### 1. activeSince

```sql
SELECT lower(person.properties.email) AS email, max(timestamp) AS last_seen, argMaxIf(properties.$current_url, timestamp, event = '$pageview') AS last_url, argMax(person_id, timestamp) AS person_id FROM events WHERE timestamp >= {since} AND timestamp < {until} AND notEmpty(person.properties.email) GROUP BY email ORDER BY last_seen ASC LIMIT {limit}
```

- values: `since` (ISO string), `until` (ISO string), `limit` (integer).
- columns: `email` Nullable(String), `last_seen` DateTime64(6, 'UTC'), `last_url`
  Nullable(String), `person_id` UUID.
- 30-day window: 6 rows, ordered by last_seen ASC, each `last_url` = `/app/dashboard` while
  `last_seen` is the later `report_exported`. Bytes read: 929,384.
- A window holding only `report_exported` returns `last_url` = `null`. `since` is inclusive and
  `until` exclusive (checked on an event at exactly 23:10:00). `LIMIT {limit}` = 2 returns the 2
  oldest.

### 2. pageviewCounts

```sql
SELECT lower(p.properties.email) AS email, coalesce(sum(c.pageviews), 0) AS pageviews_30d FROM persons AS p LEFT JOIN (SELECT person_id, uniqExact(uuid) AS pageviews FROM events WHERE event = '$pageview' AND timestamp >= now() - INTERVAL 30 DAY GROUP BY person_id) AS c ON c.person_id = p.id WHERE lower(p.properties.email) IN {emails} GROUP BY email ORDER BY email LIMIT {limit}
```

- values: `emails` (string[], lowercased), `limit` (integer, at least the list length).
- columns: `email` Nullable(String), `pageviews_30d` UInt64.
- 6 seeded emails plus `nobody@example.com`: 6 rows, each 5; no row for `nobody@example.com`
  (absent = not in PostHog). Bytes read: 1,039,758 (7 emails), 1,177,093 (500 emails).
- A person with no page views in the window still gets a row with `0` (checked by moving the
  window into the future).
- The 5 includes both anonymous pre-`$identify` page views: events reach the merged person
  through `person_id`. `count()` instead of `uniqExact(uuid)` gave 6 to 9 while duplicates were
  unmerged.
- `lower()` matching finds `Chesky@Airbnb.com` (stored with that case in
  `persons.properties.email`) from the bound `chesky@airbnb.com`.
- `IN []` returns no rows and no error.

### 3. latestEvents

```sql
SELECT event, properties.$current_url AS url, timestamp, person_id FROM events WHERE lower(person.properties.email) = {email} AND timestamp >= now() - INTERVAL 90 DAY ORDER BY timestamp DESC LIMIT 1 BY uuid LIMIT 20
```

- values: `email` (string, lowercased).
- columns: `event` String, `url` Nullable(String), `timestamp` DateTime64(6, 'UTC'), `person_id`
  UUID.
- `chesky@airbnb.com`: all 10 seeded events newest first, no duplicates while unmerged copies
  existed (`LIMIT 1 BY uuid`), `url` null for `$identify` and `report_exported`. Bytes read:
  844,004.

### 4. healthProbe

```sql
SELECT count() AS persons_with_email FROM persons WHERE notEmpty(properties.email)
```

- values: none. columns: `persons_with_email` UInt64. Result `[[6]]`. Bytes read: 704.

### Injection

`x') OR 1=1 --@example.com` and `zhao@notion.com' --` bound as `emails`, and `x') OR 1=1 --` bound
as `email`: HTTP 200, `error` null, zero rows.

### Error matrix

| Case | HTTP | `type` / `code` | `detail` | Source |
| --- | --- | --- | --- | --- |
| Invalid personal key | 403 | `authentication_error` / `authentication_failed` | `Personal API key found in request Authorization header is invalid.` | observed |
| No Authorization header | 403 | `authentication_error` / `not_authenticated` | `Authentication credentials were not provided.` | observed |
| Key valid, wrong region host (EU for a US key) | 403 | `authentication_error` / `authentication_failed` | as invalid key | observed |
| Key without `query:read` | 403 | `authentication_error` / `permission_denied` | expected `API key missing required scope 'query:read'` | from docs, not observed; same shape observed for `project:read` on GET project |
| Wrong project ID, project exists | 403 | `authentication_error` / `permission_denied` | `API key does not have access to the requested project: ID <id>.` | observed (ID 1) |
| Wrong project ID, no such project | 404 | `invalid_request` / `not_found` | `Project not found.` | observed |
| Unreachable host | none | DNS failure, `fetch` rejects | n/a | observed (curl exit 6 on `.invalid`) |
| Query timeout (10 s execution limit) | 504 | `server_error` / `error` | `Query has hit the max execution time before completing. ...` | observed (after 11 s) |
| HogQL syntax error | 400 | `validation_error` / `hogql_syntax_error` | parser message | observed |
| Read budget exhausted | 429 | `api_queries_budget_exceeded`, `Retry-After` header | not documented | from docs, not observed |
| Request rate (240/min, 2,400/h) or concurrency (3) | 429 | throttled | not documented | from docs, not observed |

`GET {host}/api/projects/{id}/` with the `query:read`-only key: 403 `permission_denied`,
`API key missing required scope 'project:read'`.

### Profile URL

PostHog's frontend defines `personByUUID` as `/persons/{uuid}` under `/project/{id}`
(`products/persons/manifest.tsx`; the mobile app's `personWebUrl` builds
`{host}/project/{projectId}/persons/{personId}`). Unauthenticated
`GET https://us.posthog.com/project/<id>/persons/8bd558e6-...` redirects to
`/login?next=/project/<id>/persons/8bd558e6-...`, so the route exists. Fed by `person_id`.

### Twenty (demo workspace, GraphQL)

Throwaway Person created with `jobTitle: 'orig'`, `leadScore: 42`, a LINKS value with a label,
and email `Spike.TCA22@Example.COM`. All test records were destroyed afterwards.

- `primaryEmail` is stored lowercased: `spike.tca22@example.com`.
- `primaryEmail: { in: ["Spike.TCA22@Example.COM"] }` -> 0 rows; lowercased -> 1 row;
  `ilike: "SPIKE.TCA22@EXAMPLE.COM"` -> 1 row. `in` is case-sensitive.
- `createPeople(data: [{ id, jobTitle: 'x' }], upsert: true)`: same id, `jobTitle` `x`,
  `leadScore`, name, email and link unchanged, `updatedAt` bumped, still one record with that
  email.
- Upsert with `{ id, leadScore: 7, leadScoredAt, linkedinLink: { primaryLinkUrl } }`: numbers and
  dates update; the LINKS composite is replaced whole, so the omitted `primaryLinkLabel` became
  `""`.
- Upsert with `leadScore: null, leadScoredAt: null, linkedinLink: null`: number and date cleared,
  the link kept its old value. An empty composite cleared it.
- Upsert with an unknown id: HTTP 200, creates a new Person with empty name and email.
- Upsert on a soft-deleted id: restores it (`deletedAt` back to null).
- `updatePerson` on a soft-deleted id updates it and leaves it deleted; on an unknown id it
  returns `NOT_FOUND` / `RECORD_NOT_FOUND`.

### Seed script reruns

Reruns with the same anchor send identical uuids and timestamps, so PostHog eventually holds one
copy, but duplicates stay visible to `count()` until the background merge (observation 3).
