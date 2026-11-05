# D-TCA-20: PostHog request contract as shipped: name, timeouts and LIMIT
**Status:** Accepted; partly supersedes D-TCA-22-posthog-api-shapes (its TCA-23 Impact line, and the explicit-LIMIT rule for single-row aggregates)
**Date:** 2026-11-05
**Issue:** TCA-20 (level 2 integration)
**Confluence:** none

**Decision:**
- Every request body also carries a `name` (required by `RunQueryInput`), so PostHog's query
  log shows which caller ran it.
- When the client's own `timeoutMs` abort fires, it rejects with kind `timeout`. Any other fetch
  rejection rejects with `unreachable`.
- The client's default timeout is 15 s, longer than PostHog's 10 s execution limit, so PostHog's
  504 normally arrives first. A caller that runs inside a function with a shorter budget passes
  `timeoutMs` below that budget. TCA-26 passes 12 s against a 15 s handler, and TCA-28 passes 7 s
  against the widget's 8 s abort.
- "Every query carries an explicit `LIMIT`" applies only to queries that return rows. The
  single-row healthProbe aggregate has none.

**Why:** TCA-23 shipped all of these, but D-TCA-22's TCA-23 Impact line leaves `name` out of the
body. Read literally, that line also files the client's own abort under "fetch rejection ->
`unreachable`". TCA-28 relies on the abort surfacing as `timeout`, so an agent that "fixed" the
client to match D-TCA-22 would break it. Two stories also had to work out the timeout rule on
their own. D-TCA-22 says every query carries an explicit `LIMIT`, yet its own healthProbe text
has none.

**Rejected:**
- Editing D-TCA-22's Impact text in place: D-TCA-20-partial-supersession keeps the original
  wording and marks the moved rules instead.
- One shared timeout for every caller: a function killed before its PostHog call ends returns no
  typed result, which loses the `timeout` banner or response.
- Adding `LIMIT 1` to healthProbe: it changes a text D-TCA-22 confirmed live, and the result
  stays the same.

**Impact:**
- Callers of `runQuery` pass a `name`. A caller whose function has a time budget below 15 s, such
  as the sync and recount jobs, passes `timeoutMs` below that budget.
- Do not map the client's own abort to `unreachable`.
- Row-returning queries keep an explicit, capped `LIMIT` (D-TCA-24). Single-row aggregates need
  none.
