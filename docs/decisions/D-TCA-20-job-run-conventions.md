# D-TCA-20: One failure mapping and one lease-release rule for every job
**Status:** Accepted
**Date:** 2026-11-05
**Issue:** TCA-20 (level 4 integration)
**Confluence:** none

**Decision:** The sync (TCA-29) and the recount (TCA-30) now follow one pattern, taken from the
sync:
- An error maps to a status through `jobFailureStatus` in `src/lib/jobs.ts`: a Twenty throttle
  or a PostHog 429 gives `rate_limited`, a PostHog timeout gives `timeout`, and anything else gives
  `error`.
- A failed `releaseLease` is logged and never changes the status the run already has. The lease
  expires through its TTL.
- Every cron enqueues through `enqueueBucketedJob` in `src/lib/jobs.ts` (bucketed `jobId`,
  per-workspace delay, `retryLimit: 0`), wrapped per job in `src/lib` (`enqueueSync`,
  `enqueueRecount`). The cron file only passes `context.workspaceId`.
- Each job exports its `timeoutSeconds` constant, and its lease TTL is that constant plus 30 s.
- Error text in logs comes from `errorText` in `posthog-client.ts`, which keeps a fetch `cause`.

**Why:** The two jobs were written in parallel and settled these points differently. In the
recount, a KV error while releasing the lease turned a run that had written every batch into
`error`, and it hid the real error when the run had already failed. The sync's mapping and its
release handling were the ones that matched the rest of the code.

**Rejected:**
- A `withLease(key, now, ttl, fn)` wrapper in `jobs.ts`: each job's log line and result shape
  differ, so the wrapper would need callbacks for each and would save only a few lines.
- Letting a release failure fail the run: the writes already happened, and with `retryLimit: 0`
  the status only reaches the log.

**Impact:** A new job maps errors with `jobFailureStatus`, releases its lease without letting a
release failure change its status, enqueues through `enqueueBucketedJob`, and derives its lease TTL from
its exported timeout.
