# DRIFT-LOG

> Contract (V2 spine §1, "Drift log"): any time an invariant is deliberately
> bent, one line here — date, invariant, reason, expiry. **An entry with no
> expiry is a bug.** An expiry in the past means the bend is closed and the
> entry is kept as history, not as an open exception.

| Date | Invariant | Reason | Expiry |
|---|---|---|---|
| 2026-08-16 | AD-7 (no machine-specific absolute paths in tracked files) | `MYTHOS-ARCHITECTURE.md:1398` carried `F:/Projects` / `F:/Documents` in an illustrative config block — doc-side, invisible to the code-scanning AD-7 test. | CLOSED 2026-08-16 (genericised to `~/Projects` / `~/Documents`). Kept as the canonical reminder that the AD-7 test scans code, not prose. |
| 2026-08-16 | Spine §4 frozen reference integrity | Both plan documents' prose claimed "23 seams" while the frozen table itself has 21 rows — the description drifted from the thing it described, in the document whose job is to prevent exactly that. | CLOSED 2026-08-16 (corrected to 21 in both docs; dated correction note added at spine §4). |
| 2026-08-16 | Suite honesty ("0 fail above baseline" in hook + CI) | BUG-258: `test/immune.test.js`'s reprobe test depended on a machine-local hermes, so the hook ran green on the operator's shell while CI's test job was red on every push since 2026-08-13. | CLOSED 2026-08-16 (`HERMES_CLI` pinned to `process.execPath` in the test; real spawn kept). |
| 2026-08-16 | "Three canonical plan documents" ceiling (root AGENTS.md) | `mythos/Plans/` holds 6 tracked files: the 3 canonical plans plus 2 adoption matrices and 1 fork-reconciliation record. The ancillary files are trackers/decision records, not plan documents — but the letter of the rule says "no more". | **OPEN** — expires when root AGENTS.md next gets a docs pass that ratifies the canonical-vs-ancillary distinction in the rule's wording (or the matrices are merged). |
| 2026-08-16 | Testing baseline ("truthful figure is 0 skipped" per root AGENTS.md, long-form TEMP) | README/ROADMAP carry "2 skipped" because the committed counts were measured in a short-`TEMP` shell; the suite itself is TEMP-form-dependent (the known libuv `fs-event.c` artefact). | **OPEN** — expires when `sync-test-count.js` normalises `TEMP`/`TMP` to long form for its own suite run, so the committed figure is shell-independent. |
