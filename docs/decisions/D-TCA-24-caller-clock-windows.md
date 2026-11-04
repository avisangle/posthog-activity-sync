# D-TCA-24: Bind query windows and limits from the caller's clock
**Status:** Accepted
**Date:** 2026-11-04
**Issue:** TCA-24
**Confluence:** none

**Decision:** `src/lib/queries.ts` uses the D-TCA-22 query texts with two substitutions: in
pageviewCounts and latestEvents, `timestamp >= now() - INTERVAL n DAY` becomes
`timestamp >= {since}`, with `since = now - n days` computed from the `now` the caller passes; in
latestEvents, `LIMIT 20` becomes `LIMIT {limit}` (default 20). activeSince and healthProbe are
verbatim. Every bound `LIMIT` is checked to be an integer from 1 to 50,000 before the query is
built.

**Why:** TCA-24's bytes fence requires each events query's `timestamp` lower bound to be a bound
value that a unit test can compare against the caller's window. `now()` is PostHog's clock, so no
test can see it, and the sync and recount would each compute "30 days ago" on a different clock
from the cursor they already hold. The placeholder syntax and binding are the ones D-TCA-22
observed working (`{since}` as an ISO string, `LIMIT {limit}` as an integer). The 1 to 50,000
check enforces D-TCA-22 observation 2: PostHog clamps a larger `LIMIT` silently.

**Rejected:**
- The spike texts verbatim, with `now() - INTERVAL n DAY`: the bound cannot be checked in a unit
  test, and query windows would follow PostHog's clock instead of the job's.
- A literal `LIMIT 20` in latestEvents: the story's builder takes `limit`, and a bound limit keeps
  the query text identical across callers (injection fence).

**Impact:**
- Builders take `now: Date` from the caller; do not reintroduce `now()` in any events query, and
  do not interpolate a window or limit into the query text.
- Callers pass a `limit` of at most 50,000; a larger value throws `RangeError` instead of being
  clamped by PostHog. pageviewCounts sets its own limit to the de-duplicated list length, so
  callers batch emails at 50,000 or fewer (TCA-29 and TCA-30 use 500).
- D-TCA-22 stays Accepted; this narrows its TCA-24 line ("use the four query texts verbatim") to
  the substitutions above.
