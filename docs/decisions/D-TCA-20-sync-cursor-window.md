# D-TCA-20: The sync window ends 10 minutes before now and re-reads its start
**Status:** Accepted
**Date:** 2026-11-05
**Issue:** TCA-20 (level 4 integration; implemented by TCA-29)
**Confluence:** none

**Decision:** Each sync run reads PostHog activity from `since` (the stored `sync:cursor`, or
`now - 30 d` on the first run) up to `windowEnd = now - 10 min`. The activeSince query matches
`last_seen >= since`, so rows at the cursor's exact timestamp are read again by the next run. On a
normal run the cursor moves to `windowEnd`; at the 5,000-row cap it moves to the last row's
`last_seen` (D-TCA-29-sync-input-guards covers the tie at `since`).

**Why:** PostHog can ingest an event minutes after its `timestamp`. A window ending at `now` moves
the cursor past such an event before it is queryable, and no later window includes it again, so
that person's fields stay stale until their next event. Ten minutes of lag keeps late events
inside a later window. Re-reading the cursor's timestamp costs nothing: writes are diff-only
(D-TCA-27-diff-only-batched-writes), so an unchanged row makes no Twenty request.

**Rejected:**
- `windowEnd = now`: late-ingested events are skipped for good, with no signal.
- `last_seen > cursor`: a row sharing the cursor's millisecond with the previous page's last row
  is skipped.

**Accepted cost:** Fields lag real activity by 10 minutes plus up to an hour between runs.

**Impact:** The sync window end stays behind `now` by at least the ingestion lag, and the keyset
comparison stays inclusive. The epic's design table names D-TCA-27-job-scheduling for this call;
this record is where it lives.
