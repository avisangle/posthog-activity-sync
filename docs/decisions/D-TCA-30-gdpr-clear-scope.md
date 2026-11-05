# D-TCA-30: The daily recount clears only people seen in the last 31 days
**Status:** Accepted
**Date:** 2026-11-05
**Issue:** TCA-30
**Confluence:** none

**Decision:** The daily recount reads only people whose `posthogLastSeenAt` is within the last
31 days of the job's `now`. For each of them it sets `posthogPageviews30d` from PostHog, or clears
all four PostHog fields when the email is no longer in PostHog persons (for example, deleted for
GDPR). A person deleted from PostHog whose `posthogLastSeenAt` is older than 31 days keeps the
values Twenty already holds.

**Why:** The recount sends one PostHog query per 500 people it reads, and each query's bytes read
counts against the project's query budget. Bounding the read by `posthogLastSeenAt` keeps the
daily cost proportional to recently active people instead of to every person who ever had
PostHog activity. 31 days covers the 30-day page view window plus a day of slack, so every person
whose count can still decay is recounted. A cleared person has `posthogLastSeenAt` null, so the
next run does not read or rewrite them.

**Rejected:**
- Recounting every person with any PostHog value: query count and bytes read grow without bound
  with the workspace's history, every day, to catch deletions that are rare.

**Impact:** The README must state the limit: people deleted from PostHog keep their PostHog field
values in Twenty when their `posthogLastSeenAt` is more than 31 days old. Any future "clear
everything" path must be a separate, explicit job, not a wider window in the daily recount.
