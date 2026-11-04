# D-TCA-27: Time-bucketed job ids and one per-workspace start offset for every cron
**Status:** Accepted
**Date:** 2026-11-05
**Issue:** TCA-27
**Confluence:** none

**Decision:** Every cron enqueues its job with a `jobId` that carries a UTC bucket
(`hourBucketJobId` gives `<prefix>:YYYY-MM-DDTHH`, `dayBucketJobId` gives `<prefix>:YYYY-MM-DD`)
and a start delay of `stableOffsetMs(workspaceId, JOB_OFFSET_WINDOW_MS)`, a 32-bit FNV-1a hash of
the workspace id modulo 50 minutes. The hourly sync cron fires at minute 0 and the daily recount
cron at minute 30, so with one shared window a workspace's recount always starts 30 minutes after
a sync start and 30 minutes before the next.

**Why:** Twenty's queue ignores a job id it already holds, and its docs recommend an id that
includes a time window: one bucket per run lets each hour or day enqueue once, even if the cron
fires twice. The offset spreads workspaces across the hour so they do not all hit the shared
500-requests-per-minute budget at minute 0, and a stable hash keeps one workspace's runs evenly
spaced. Using the same window for both crons matters because of the shared write lease
(D-TCA-27-shared-write-lease): `h mod 3_600_000` and `h mod 3_000_000` always differ by a
multiple of 600,000 ms, so with a 60-minute recount window about 1 in 6 workspaces (16 to 17
percent over 10,000 simulated ids) would start the recount at exactly a sync's start, find the
lease held and skip the recount every day.

**Rejected:**
- One fixed `jobId` forever: the queue ignores an id it still holds, so a stuck or delayed run
  blocks every later one.
- A random delay: two consecutive runs can land minutes apart, or overlap.
- A separate window per cron (50 minutes for the sync, 60 for the recount): collides with the
  sync start for about 1 in 6 workspaces, every day.

**Impact:** Every cron in this app enqueues with `hourBucketJobId` or `dayBucketJobId` and a
delay of `stableOffsetMs(workspaceId, JOB_OFFSET_WINDOW_MS)`; never a different window. The lease
rule lives in D-TCA-27-shared-write-lease.
