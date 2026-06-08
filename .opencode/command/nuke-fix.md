---
description: Execute a nuke-audit fix spec with phased subagent implementation, validation, and fix loops.
---

## User Input

```text
$ARGUMENTS
```

Use the input as the path to `fix-spec.md`. If the input is empty, find the newest `.nuke/*/fix-spec.md` and ask for confirmation only if more than one plausible latest candidate exists.

## Non-Negotiable Rules

- Read `CLAUDE.md` first, then the provided fix spec.
- Never run `git add`, `git stage`, `git commit`, or `git stash`.
- No `.bak` files.
- Fix every task in the spec, including low and info severity work.
- Use the strongest available model and maximum reasoning effort for every implementer, validator, and fixer.
- Use subagents aggressively, but run at most 10 subagents concurrently.
- Implementers never validate their own work.
- Do not move to the next phase until the current phase is fully clean.
- Evidence beats claims: every success needs file:line evidence and gate output.

## Phase 0 - Intake And Baseline

1. Read the full fix spec.
2. Read or create `fix-progress.md` next to the spec.
3. Run the baseline gates from the spec. If the spec does not list gates, run:
   - `npm run format:check`
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
   - `npm run check:invariants`
   - `npm run test-ci`
4. If any baseline gate fails, adopt that failure as the first fix task. Do not validate around a broken baseline.
5. Update `fix-progress.md` with phase statuses and baseline results.

## Per-Phase Protocol

For each phase in the spec, in order:

1. Dispatch implementation subagents for all parallel-safe batches in the phase, max 10 at once.
2. Each implementer receives only:
   - executor context from the spec
   - its batch tasks
   - its owned file list
   - instruction to avoid unrelated edits
   - instruction to return changed files, file:line evidence, task status, and deviations
3. After implementation, dispatch fresh validation subagents. Validators must:
   - verify each task acceptance criterion with file:line evidence
   - re-audit every changed file for new correctness, security, DRY, KISS, YAGNI, SRP, naming, type, test, slop, and docs issues
   - run the phase gates from the spec
4. Any failed criterion, failed gate, or new issue of any severity starts a fix loop:
   - dispatch fixer subagents with exact validation failures
   - keep file ownership narrow
   - rerun fresh validation after fixes
   - repeat until clean
5. If a phase takes more than 5 fix cycles, stop, write the exact blockers to `fix-progress.md`, and report honestly.
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
2. Dispatch a final full-sweep validation wave:
   - correctness and security reviewer
   - structure and code-quality reviewer
   - completeness reviewer
3. Completeness reviewer must verify:
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
