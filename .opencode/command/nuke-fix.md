---
description: Execute a nuke-audit fix spec with phased subagent implementation, validation, and fix loops.
---

## User Input

```text
$ARGUMENTS
```

Use the input as `[mode] <path-to-fix-spec.md>`. If mode is omitted, use the `mode:` header in the spec; if the spec has no mode header, use `light`. If the spec path is omitted, ask for it instead of guessing from `.nuke/`.

## Non-Negotiable Rules

- Read `CLAUDE.md` first, then the provided fix spec.
- Never run `git add`, `git stage`, `git commit`, or `git stash`.
- No `.bak` files.
- Fix every task in the spec, including low and info severity work.
- Respect the selected mode. Light-mode agents inherit the session model; full mode uses the strongest available model and maximum reasoning effort.
- Use the current nuke-fix skill protocol: light mode validates with one fresh validator per phase; full mode validates with a fresh validation wave.
- Implementers never validate their own work.
- Do not move to the next phase until the current phase is fully clean.
- Evidence beats claims: every success needs file:line evidence and gate output.

## Phase 0 - Intake And Baseline

1. Read the full fix spec.
2. Read `mode:` from the spec unless the user supplied an explicit mode.
3. Read or create `fix-progress.md` next to the spec.
4. Run the baseline gates from the spec. If the spec does not list gates, run:
   - `npm run format:check`
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
   - `npm run check:invariants`
   - `npm run test-ci`
5. If any baseline gate fails, adopt that failure as the first fix task. Do not validate around a broken baseline.
6. Update `fix-progress.md` with phase statuses and baseline results.

## Per-Phase Protocol

For each phase in the spec, in order:

1. Dispatch implementation subagents for all parallel-safe batches in the phase.
2. Each implementer receives only:
   - executor context from the spec
   - its batch tasks
   - its owned file list
   - instruction to avoid unrelated edits
   - instruction to return changed files, file:line evidence, task status, and deviations
3. After implementation, dispatch fresh validation. Light mode uses one fresh validator for the phase; full mode uses a validation wave. Validators must:
   - verify each task acceptance criterion with file:line evidence
   - re-audit every changed file for new correctness, security, DRY, KISS, YAGNI, SRP, naming, type, test, slop, and docs issues
   - run the phase gates from the spec
4. Any failed criterion, failed gate, or new issue of any severity starts a fix loop:
   - dispatch fixer subagents with exact validation failures
   - keep file ownership narrow
   - rerun fresh validation after fixes
   - repeat until clean
5. If a phase hits the mode cap, stop, write the exact blockers to `fix-progress.md`, and report honestly. Caps: light = 3 cycles; full = 5 cycles.
6. Mark a phase done only after all validators pass and all gates pass.

## Final Verification

After the last phase:

1. Run all gates again:
   - `npm run format:check`
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
   - `npm run check:invariants`
   - `npm run test-ci`
2. Dispatch the final sweep by mode:
   - light: one reviewer covering correctness, security, structure/quality, and completeness
   - full: correctness/security reviewer, structure/quality reviewer, and completeness reviewer
3. Completeness must verify:
   - every task in the spec is done
   - every `F-###` in the coverage map is resolved
   - no `.bak` files exist
   - no debug leftovers or commented-out dead code were introduced
   - working tree changes are explainable and scoped to the spec
4. Anything found starts one more fix loop, followed by another final sweep.

## Progress File

Keep `fix-progress.md` next to the spec:

```markdown
# Fix Progress
spec: fix-spec.md | started: <date>
baseline: <gate summary>

| Phase | Status | Cycles | Notes |
|---|---|---:|---|
| 1 | done | 2 | <notes> |
| 2 | in-progress | 1 | <notes> |
```

## Final Output

Report:

- phases completed and cycle counts
- gate results
- final sweep verdict
- remaining blockers, if any
- exact statement: `ALL SOTA - working tree ready for review (nothing committed)` only when everything is clean
