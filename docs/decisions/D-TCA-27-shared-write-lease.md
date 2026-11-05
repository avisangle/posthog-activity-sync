# D-TCA-27: All four fields per written record, under one shared write lease
**Status:** Accepted; partly supersedes D-TCA-22-posthog-api-shapes (its TCA-27 Impact line: the `{ id, <changed fields> }` payload)
**Date:** 2026-11-05
**Issue:** TCA-27
**Confluence:** none

**Decision:** Each changed record is written as `{ id, <all four fields> }`, every field taken
from the job's new values where it supplied one and from the same-run snapshot otherwise. Every
job that writes Person activity holds the one KV lease `ACTIVITY_WRITE_LEASE`
(`'activity-write-lease'`) from before its first Twenty read until after its last write. This
supersedes D-TCA-22's `{ id, <changed fields> }` payload; the rest of D-TCA-22 (same-run ids,
LINKS write and clear shapes, batched upsert) stands.

**Why:** The D-TCA-22 spike observed omitted fields left alone on a single-record upsert, but
never a 200-record batch whose records have different key sets. `createMany` splits records into
inserts and updates server-side, and a uniform payload removes any dependence on how it builds
the update, at no request cost. Re-sending unchanged fields is safe only if no other job wrote
since this job's read. The hourly sync and the daily recount both write `posthogPageviews30d`,
and a recount clear writes all four fields, so overlapping jobs can put back values read before
the other job wrote, whichever payload is used. One shared lease means they never overlap.

**Rejected:**
- Changed fields only per record: does not remove the overlap race (both jobs write
  `posthogPageviews30d`, and a clear writes all four), and mixed key sets in one batch were never
  observed.
- One lease per job (`sync:lease`, `recount:lease`): the jobs can overlap, and a recount writes
  back values read before a sync wrote. Those stay stale until that person's next event, because
  the sync cursor has already moved past them.
- Accepting the race: silent, data-dependent staleness with no signal to an operator.

**Accepted cost:** A job that finds the lease held exits `locked` without writing, and with
`retryLimit: 0` nothing retries it. A skipped sync resumes from its cursor the next hour. A
skipped recount waits a day; with the 30-minute separation from D-TCA-27-job-scheduling this only
happens when the queue delays a job by more than about 25 minutes. The lease is check-then-set
(KV has no compare-and-set), so two jobs reading an empty key within milliseconds could both
acquire it; the same 30-minute separation makes that the same queue-delay case.

**Impact:** Any job that calls `writeActivity` acquires `ACTIVITY_WRITE_LEASE` with
`acquireLease` before its first read, with a TTL above its `timeoutSeconds`, exits without
writing when it is held, and releases it after its last write. No job uses a separate lease key
for Person writes.
