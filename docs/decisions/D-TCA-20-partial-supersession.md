# D-TCA-20: How a record marks a partial supersession
**Status:** Accepted
**Date:** 2026-11-05
**Issue:** TCA-20 (level 1 integration)
**Confluence:** none

**Decision:** When a later record overrides only part of an earlier one, the earlier record's
Status reads `Accepted; partly superseded by <ID> (<what>)`, naming exactly which rules moved,
and the overridden Impact bullet gets an inline note pointing at the new record. The newer
record's Status reads `Accepted; partly supersedes <ID> (<which Impact line>)`. Original text
and Evidence stay as written.

**Why:** D-TCA-22 holds rules for four stories in one file, and later stories amend single
bullets of it (TCA-24 already has; TCA-27 will). Its first partial mark said the whole "TCA-24
Impact line" was superseded while the body note named only two query texts, and the profile-URL
host correction lived only in D-TCA-24. A reader of D-TCA-22 alone could not tell which rules
were stale. Naming the moved rules in the Status line makes the old file self-describing.

**Rejected:**
- `Superseded by <ID>` on the whole record: marks still-valid rules (error matrix, health probe,
  Twenty write method) as dead.
- Rewriting the old Impact text in place: erases what was decided at the time, which is the
  record's purpose.
- Splitting D-TCA-22 into one record per consuming story: churns IDs that issues and code
  comments already cite.

**Impact:** Any record that amends part of another (next expected: TCA-27 against D-TCA-22's
TCA-27 line) edits the old record's Status to `Accepted; partly superseded by <ID> (<what>)`
and adds an inline note on the affected Impact bullet, in the same PR.
