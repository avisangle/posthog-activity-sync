# D-TCA-20: One email normaliser, exported from queries.ts
**Status:** Accepted
**Date:** 2026-11-05
**Issue:** TCA-20 (level 3 integration)
**Confluence:** none

**Decision:** `normalizeEmail` in `src/lib/queries.ts` (trim plus lowercase, `''` for null,
undefined or blank) is the only email normaliser. `match-people.ts` and `activity.ts` call it
instead of keeping their own copies.

**Why:** Level 3 left three copies: TCA-24's in `queries.ts`, TCA-27's in `match-people.ts`, and
TCA-28's `.trim()` in `activity.ts`. The sync and the recount match Twenty-side keys against
PostHog-side values. If one copy changed and the others did not, a person's keys would stop
matching and the daily recount would clear them (D-TCA-30-gdpr-clear-scope).

**Rejected:** Homing it in `match-people.ts`. `queries.ts` would then depend on the Twenty
data-access module, the reverse of the current direction.

**Impact:** Code that compares, keys or binds an email uses this function and does not trim or
lowercase on its own. A change to the transform changes the HogQL side in the same PR.
