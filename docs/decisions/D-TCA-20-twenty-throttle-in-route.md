# D-TCA-20: The activity route reports a Twenty throttle as rate_limited
**Status:** Accepted
**Date:** 2026-11-05
**Issue:** TCA-20 (level 3 integration)
**Confluence:** none

**Decision:** `readPrimaryEmail` wraps its `CoreApiClient` call in `withRateLimit`. `getActivity`
returns `rate_limited` with "Twenty is busy, try again in a minute" for a `TwentyRateLimitError`.

**Why:** TCA-27 wrapped every Twenty call in `match-people.ts` and `write-activity.ts`. TCA-28's
Person read was not wrapped, so a Twenty throttle reached the widget as the generic "Could not load
PostHog activity". That message blames PostHog and does not tell the user to retry. The TCA-31
widget already shows the route's message and a Try again action for `rate_limited`.

**Rejected:** A new `twenty_busy` status. Every `ActivityResponse` consumer would need a new branch
for an outcome that `rate_limited` already covers.

**Impact:** Every `CoreApiClient` call in `src/lib` runs inside `withRateLimit`. A user-facing path
reports `TwentyRateLimitError` as `rate_limited`, with a message that names Twenty.
