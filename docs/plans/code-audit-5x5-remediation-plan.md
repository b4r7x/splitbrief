# diptych Code Audit Remediation Plan (5/5 Target)

## Purpose
Execute all fixes needed to move the codebase from the latest audit score (~3.7/5 overall) to 5/5 across all categories.

This plan is written for an AI coding agent with **empty context**.

## Repository + Rules (must read first)
- Project root: `/Users/voitz/Projects/diptych`
- Read first: `AGENTS.md`, `CLAUDE.md`
- Hard rule: **do not run `git add`, `git stage`, `git commit`**.
- Tech constraints:
  - Node 22+, TypeScript 6, ESM imports with `.js`
  - Zero classes (except currently existing legacy spots you are removing here)
  - No `useMemo`, `useCallback`, `React.memo`, `forwardRef`, `useImperativeHandle`
  - External stores over React Context

## Done Criteria
All of the following must pass:
1. `npm run typecheck`
2. `npm run lint`
3. `npm test`
4. All tasks below implemented with no regressions

---

## Task 1 — Security: Fix project-root path validation
### Why
`validateTaskPath()` uses prefix matching and can allow sibling-directory escapes.

### Files
- `src/core/paths-io.ts`
- Add/update tests in the nearest colocated test file (`src/core/paths-io.test.ts`)

### Changes
- Replace `startsWith(resolve(projectDir))` guard with robust relative-path validation:
  - Resolve both root and target
  - `rel = relative(root, target)`
  - Reject if `rel` is empty? (allow root file paths as valid), reject if `rel.startsWith('..')` or `isAbsolute(rel)`
- Preserve behavior for normal in-project relative paths.

### Acceptance
- New tests cover:
  - valid nested file path
  - escape attempt `../other/file.ts`
  - absolute input path rejection
  - edge case similar prefix (`project` vs `project-evil`)

---

## Task 2 — Planner phase persistence correctness
### Why
Planner base stores raw stdout in phases; orchestrator persists phase text to files. This can overwrite generated artifacts with non-artifact output.

### Files
- `src/engine/planners/base.ts`
- `src/engine/planners/types.ts` (if type expansion needed)
- `src/engine/orchestrator/planning.ts`
- Affected planner/orchestrator tests

### Changes
- Ensure `phases[].text` is the **resolved artifact content** (the same content used as spec/plan/tasks), not raw stdout.
- If raw stdout must be retained, store it under a separate field and never persist it as artifact file content.
- Update tests to lock this behavior.

### Acceptance
- Persisted files always contain artifact content from `readPhaseOutput` path.
- Existing planner tests still pass with updated expectations.

---

## Task 3 — `init` command bootstraps detection/session state
### Why
Setup screen can show empty planner detection because `init` path skips detection/session bootstrap.

### Files
- `src/cli/commands/init.ts`
- `src/cli/init-stores.ts` (or shared bootstrap module)
- relevant tests under `src/cli/**`

### Changes
- Reuse shared store bootstrap (or equivalent explicit loading) before rendering setup screen.
- Ensure config + detection + sessions are loaded consistently with other entry points.

### Acceptance
- `init` flow provides detected planner/implementer data in setup UI path.
- No duplicated bootstrap logic if avoidable.

---

## Task 4 — Error handling: preserve non-missing SDK import errors
### Why
`loadSdk()` currently maps all import failures to “not installed”.

### Files
- `src/engine/agent-sdk.ts`
- tests near this module

### Changes
- Only map module-not-found style failures to install message.
- Re-throw or wrap other import/runtime failures with original message preserved.

### Acceptance
- Test one “module missing” path and one “other import failure” path.

---

## Task 5 — Validation command parsing robustness
### Why
`validation.testCommand.split(/\s+/)` breaks quoted args.

### Files
- `src/engine/orchestrator/validator.ts`
- related tests

### Changes
- Replace naive split with safe parsing strategy.
- Prefer storing command/args separately if schema impact is manageable; otherwise use a robust tokenizer compatible with quotes.

### Acceptance
- Test command like `npm run test -- --grep "foo bar"` is parsed/executed with expected argv.

---

## Task 6 — Detection cache entry validation hardening
### Why
Cache validation only verifies array shape, not array element structure.

### Files
- `src/core/detection/cache.ts`
- related tests

### Changes
- Validate each planner/implementer entry shape (schema-based preferred).
- If cache malformed, return `null` and continue safely.

### Acceptance
- Malformed entries are rejected.
- Valid cache still loads.

---

## Task 7 — Question parser resilience on malformed marker
### Why
On unbalanced marker JSON, extraction currently `break`s and misses later valid markers in the same chunk.

### Files
- `src/engine/parsers/question-parser.ts`
- `src/engine/parsers/question-parser.test.ts`

### Changes
- On `jsonEnd === -1`, advance cursor and continue scanning, do not stop whole parse.

### Acceptance
- Test: malformed first marker + valid second marker => second marker extracted.

---

## Task 8 — Break providers/model-display barrel cycle
### Why
`core/providers.ts` re-exports from `model-display.ts` while `model-display.ts` imports from `core/providers.ts`.

### Files
- `src/core/providers.ts`
- `src/core/model-display.ts`
- any impacted import sites

### Changes
- Remove cyclic dependency by importing provider display API directly from stable source module (e.g. provider catalog), not through barrel.
- Keep public API clean; avoid introducing new cycles.

### Acceptance
- No providers↔model-display import cycle.
- Typecheck/lint clean.

---

## Task 9 — DRY/refactor: runner kind single source of truth
### Why
Runner kind matrix is duplicated across schemas/build/migration.

### Files
- `src/core/types/schemas/runner-fields.ts`
- `src/core/types/schemas/planner-config.ts`
- `src/core/types/schemas/implementer-config.ts`
- `src/core/config/build-runner.ts`
- `src/core/config/migration.ts`
- relevant tests

### Changes
- Introduce canonical runner descriptor map used by:
  - schema composition
  - build-runner construction
  - migration normalization
- Remove duplicated per-kind mapping logic.

### Acceptance
- Behavior unchanged for valid configs.
- Tests updated/added for all runner kinds.

---

## Task 10 — DRY/refactor: unify planner/implementer API invocation plumbing
### Why
Planner and implementer API backends duplicate model resolution + transport/usage handling.

### Files
- `src/engine/planners/api.ts`
- `src/engine/implementers/api.ts`
- optionally new shared helper under `src/engine/`
- tests

### Changes
- Extract shared API invocation helper for common flow.
- Keep role-specific prompt semantics separate.

### Acceptance
- No behavior regressions.
- Usage propagation and output shape remain correct.

---

## Task 11 — DRY/refactor: shell/agent/cli wrapper setup dedup
### Why
Thin wrappers repeat command/arg/outputFormat/availability boilerplate.

### Files
- `src/engine/planners/cli.ts`
- `src/engine/planners/shell.ts`
- `src/engine/planners/agent.ts`
- `src/engine/planners/agent-sdk.ts`
- `src/engine/implementers/cli.ts`
- `src/engine/implementers/shell.ts`
- `src/engine/implementers/agent.ts`
- `src/engine/implementers/agent-sdk.ts`
- `src/engine/planners/command-invoke.ts`
- maybe new shared helper(s)

### Changes
- Centralize shared setup logic while preserving planner vs implementer behavior.
- Ensure token usage is not lost in command-based planner path if available from parser.

### Acceptance
- Reduced duplication with same runtime behavior.
- Tests pass across all wrapper variants.

---

## Task 12 — Convention cleanup: remove class-based CLI error type
### Why
Repo convention is zero classes; `CliError` is class-based.

### Files
- `src/cli/errors.ts`
- all call sites/tests

### Changes
- Replace class + `instanceof` checks with functional error object/predicate pattern.
- Preserve exit code propagation behavior.

### Acceptance
- No class remains in this path.
- CLI behavior unchanged.

---

## Optional Task 13 — Store boundary cleanup (SRP/file organization)
### Why
`detectionStore` currently orchestrates external fetching/cache persistence; `model-cache` hosts catalog resolution logic.

### Files
- `src/stores/detection.ts`
- `src/stores/model-cache.ts`
- possible new service modules

### Changes
- Move orchestration into service layer; keep stores focused on state operations.
- Move catalog resolution helper out of `model-cache` store module.

### Acceptance
- Cleaner store boundaries, no behavior changes.

---

## Execution Order
Run tasks in this order:
1. Task 1
2. Task 2
3. Task 3
4. Tasks 4–8 (can be parallel if careful)
5. Tasks 9–12 (refactor wave)
6. Optional Task 13

After each task (or small batch):
- `npm run typecheck`
- `npm run lint`
- Run focused tests for touched modules

Final gate:
- `npm test`

---

## Final Report Format (required)
At the end, output:
1. Files changed
2. Task-by-task status (done/partial)
3. Any deliberate deviations
4. Final command results summary for:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
5. Remaining risks (if any)
