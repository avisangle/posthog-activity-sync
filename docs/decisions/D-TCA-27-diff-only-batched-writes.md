# D-TCA-27: Diff-only batched Person writes and case-insensitive email matching
**Status:** Accepted
**Date:** 2026-11-05
**Issue:** TCA-27
**Confluence:** none

**Decision:** `writeActivity` writes only records where at least one supplied value differs from
the same-run snapshot, sending them in batches of 200 through `createPeople(data, upsert: true)`
(the payload per record is set by D-TCA-27-shared-write-lease). Dates compare by instant, numbers
by value, and LINKS by URL with a stored `''` equal to `null`. `findPeopleByEmails` matches with
`ilike` on each trimmed, lowercased email, `\`, `%` and `_` escaped, 50 emails per request, then
keeps only rows whose trimmed, lowercased `primaryEmail` equals a queried email.

**Why:** Twenty's 500 requests per minute are shared by every workspace that installed the app,
and they count requests, not records. Skipping unchanged people means a second sync over the same
window makes no write requests, and batching makes a write cost `ceil(changed / 200)` requests.
A cleared LINKS field reads back as `primaryLinkUrl: ''` (D-TCA-22 Evidence), so a compare that
kept `''` distinct from `null` would rewrite every cleared person on every run. On emails,
`primaryEmail.in` is case-sensitive (D-TCA-22 Evidence) while PostHog emails arrive in any case.
`_` is common in addresses and is an `ilike` wildcard, so escaping alone is not enough without the
exact in-memory compare that drops wildcard and substring hits.

**Rejected:**
- `primaryEmail.in`: case-sensitive, misses `Maya@Acme.com` stored as `maya@acme.com`.
- `updatePerson` per person: see D-TCA-22-posthog-api-shapes, Rejected.
- Writing every person the job touched: a second sync would rewrite unchanged records and spend
  the shared request budget for nothing.

**Impact:** Every Person write in this app goes through `writeActivity`; only `match-people.ts`
creates a `PersonSnapshot` (the brand enforces it in types). Never compare a LINKS value without
mapping `''` to `null` first.
