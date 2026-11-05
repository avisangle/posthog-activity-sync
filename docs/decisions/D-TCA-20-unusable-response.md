# D-TCA-20: An unusable PostHog 200 is a server_error, wherever it is detected
**Status:** Accepted
**Date:** 2026-11-05
**Issue:** TCA-20 (level 2 integration)
**Confluence:** none

**Decision:** When PostHog answers 200 with a payload the app cannot use, the code throws
`PostHogError('server_error', ...)`. This covers `posthog-client`'s bad-shape check (no
`columns`/`results` arrays) and the `queries.ts` row parsers (missing column, unreadable
timestamp, non-numeric count). Plain `Error` and `RangeError` stay for caller mistakes: a builder's out-of-range
`limit` or empty email list.

**Why:** TCA-23 and TCA-24 each detected an unusable response, and they threw different types:
`PostHogError('server_error')` in the client and a plain `Error` or `RangeError` in the parsers.
Every consumer maps on `PostHogError.kind` and treats anything else as an unexpected bug. So
TCA-26's health check showed an actionable "PostHog returned an error, check the host" banner for
one case and a generic "The health check failed" for the other. The same split was about to reach
TCA-28's route and the sync jobs' retry and park decisions.

**Rejected:**
- Leave the parsers' plain errors: every consumer has to recognise two failure types for one
  condition, and the ones built so far already treat them differently.
- A new `unexpected_response` kind: it adds a ninth row to every kind-keyed table (TCA-26, TCA-28)
  with the same message as `server_error`, whose banner already says "or an unexpected response".

**Impact:**
- `queries.ts` parsers throw `PostHogError('server_error')` for any unusable row data. Consumers
  must not special-case parser errors.
- New response checks in `src/lib` use the same kind.
