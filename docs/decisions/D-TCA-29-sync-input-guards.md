# D-TCA-29: The sync distrusts two PostHog inputs: the last URL's scheme and timestamp ties
**Status:** Accepted
**Date:** 2026-11-05
**Issue:** TCA-29
**Confluence:** none

**Decision:**
- `runSync` writes `posthogLastPage` only when `last_url` parses as an `http:` or `https:` URL.
  Any other value is treated like a null URL: the field is left out of `next`, so the stored
  page stays.
- When an activeSince page hits the 5,000-row cap and its last row's `last_seen` is not after
  the window's `since`, the cursor moves to `since + 1 ms` instead of staying put, and the run
  logs it.

**Why:** Both values come from the tracked browser. Anyone holding the public `phc_` project key
can send events with any `$current_url` and any `timestamp`.
- A `javascript:` or `data:` URL stored in a LINKS field becomes a clickable link on the Person
  record.
- The keyset cursor re-reads `last_seen >= cursor`. If 5,000 or more emails share the cursor's
  millisecond (row timestamps are parsed to millisecond ISO strings), every run gets the same
  full page back, sets the cursor to the same instant, and the sync stops advancing for good.
  Real traffic is very unlikely to do this, but forged events can.

**Rejected:**
- A composite `(last_seen, email)` keyset cursor: it would change the activeSince text that
  D-TCA-22 fixes verbatim, and that text was confirmed live.
- Validating URLs in `write-activity.ts` for every writer: the sync is the only writer that sets
  a last page (the recount only clears it), and the writer's contract is owned by TCA-27.
- Keeping the cursor on a tie: it stalls the sync forever with no operator signal.

**Accepted cost:** On the tie path, rows tied at that millisecond beyond the first 5,000 are
skipped for this window. Their people update again on their next event.

**Impact:**
- Never write a PostHog-supplied URL into a LINKS field without the http(s) check.
- A cursor update must always move forward. Any later keyset change keeps that rule.
