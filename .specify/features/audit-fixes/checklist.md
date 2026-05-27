# Progress Checklist: Audit Fixes

**Created**: 2026-05-27
**Source**: `docs/audits/full-codebase-audit-2026-05-26.md`

## Phase Status

- [ ] CHK001 **P0a — Critical Bugs & Security** (9 tasks: T001–T009)
- [ ] CHK002 **P0b — Correctness & State Machine** (5 tasks: T010–T014)
- [ ] CHK003 **P1 — Canonical Helpers & Shared Types** (19 tasks: T015–T033)
- [ ] CHK004 **P2 — Parameter Design Refactors** (9 tasks: T034–T042)
- [ ] CHK005 **P3 — SRP Splits** (7 tasks: T043–T049)
- [ ] CHK006 **P4 — Type Safety** (11 tasks: T050–T060)
- [ ] CHK007 **P5 — Dead Code Purge** (10 tasks: T061–T070)
- [ ] CHK008 **P6 — Architecture Fixes** (8 tasks: T071–T078)

## Critical Bugs (must verify first)

- [ ] CHK009 BUG-1: `replaceAll` in apply.ts (T001) — no more silent partial patches
- [ ] CHK010 BUG-2: SKIP_TASK resets phase+attempt (T002) — no more crash on resume
- [ ] CHK011 SEC-1: No `String(err)` in use-workflow-runner.ts (T003) — no API key leaks
- [ ] CHK012 PERF-1: Sink subscription guard in init.ts (T010) — no more N-duplicate writes
- [ ] CHK013 IPC-1: Prompt timeout in server.ts (T011) — no more permanent hang
- [ ] CHK014 DEAD-2: plan_done/post_planning hook mapping removed (T064) — no silent hook failure

## Invariant Checks (run after every phase)

- [ ] CHK015 `find src -name 'index.ts'` → empty (zero barrels)
- [ ] CHK016 `grep -rn 'useMemo\|useCallback\|React\.memo' src/ --include='*.ts' --include='*.tsx' | grep -v test` → empty
- [ ] CHK017 `grep -rn "from 'react'\|from 'ink'" src/engine/ | grep -v test` → empty (engine layer clean)
- [ ] CHK018 `npm run test-ci` → PASS (typecheck + lint + test)

## Final Validation

- [ ] CHK019 All 78 tasks checked off in tasks.md
- [ ] CHK020 `npm run test-ci` passes clean
- [ ] CHK021 No new `index.ts` barrels created
- [ ] CHK022 No engine→react imports introduced
- [ ] CHK023 All "Done when" grep conditions verified
