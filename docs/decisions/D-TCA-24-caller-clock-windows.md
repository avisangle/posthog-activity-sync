# D-TCA-24: Events-query windows come from the caller's clock
**Status:** Accepted; supersedes the TCA-24 Impact line of D-TCA-22-posthog-api-shapes
**Date:** 2026-11-04
**Issue:** TCA-24
**Confluence:** none

**Decision:** `pageviewCountsQuery` and `latestEventsQuery` bind their lower bound as
`timestamp >= {since}`, where `since` is computed from the `now: Date` the caller passes
(`now - 30 days` and `now - days`), and `latestEventsQuery` binds `LIMIT {limit}`. activeSince and
healthProbe keep D-TCA-22's texts verbatim. Every bound `limit` must be an integer from 1 to
50,000, else the builder throws `RangeError`. This supersedes D-TCA-22's TCA-24 Impact line
("use the four query texts below verbatim") for the pageviewCounts and latestEvents texts; the
rest of D-TCA-22 stands.

**Why:** PostHog's `now()` is invisible to a unit test, so a test cannot check that each events
query is bounded by the intended window (the bytes fence). It is also a second clock: the sync
and recount would compute "30 days ago" on PostHog's clock instead of the job's injected `now`,
so a job's cursor window and its page-view window could disagree. The limit cap exists because
PostHog clamps any `LIMIT` above 50,000 without reporting truncation (D-TCA-22 observation 2).
Both substituted texts were run against the seeded project before merge (PR body of TCA-24).

**Rejected:**
- D-TCA-22's `now() - INTERVAL n DAY` texts verbatim: the window cannot be tested and runs on a
  second clock.
- A literal `LIMIT 20` in latestEvents: the builder takes `limit`, and a literal would ignore it.
- Interpolating the window or limit into the text: breaks the bound-values-only rule.

**Impact:**
- Builders take `now: Date` from the caller; no events query uses `now()`.
- No window, limit or email is interpolated; all go through `values`.
- A limit outside integer 1..50,000 throws `RangeError`; `pageviewCountsQuery` binds `limit` as
  the de-duplicated email count, so callers batch at most 50,000 emails.
- `profileUrl`'s host is `readSettings().host`, which is `POSTHOG_CUSTOM_HOST` when
  `POSTHOG_HOST` is `custom` (D-TCA-22 calls it "the configured `POSTHOG_HOST`").
