# Research: Deep Code Quality Fixes

**Feature**: 019-deep-quality-fixes
**Date**: 2026-04-01
**Sources**: 20-agent deep code audit + 3 focused research agents

## 1. Subprocess Event Ordering in Node.js

**Decision**: Register `activeProcesses.add(proc)` immediately after `spawn()`, before any event handlers.

**Rationale**: Node.js `spawn()` ENOENT errors fire asynchronously (next tick via microtask), so all synchronous code after `spawn()` executes before the error handler fires. Placing `add(proc)` first ensures the process is tracked before any error/close handler tries to `delete(proc)`. The current code in `process.ts` registers the error handler before `add()`, creating a theoretical race window.

**Alternatives considered**:
- Keep current ordering (error handler first) — rejected because it creates a window where `delete` runs on a process never `add`ed, and if error fires between handler registration and `add`, the process stays in the set forever.
- Use a synchronous try/catch around `spawn()` — already done in `spawn.ts` and `implementers/` but not in `process.ts`. Both layers are needed for complete coverage.

## 2. Unified Subprocess Utility Design

**Decision**: Move `spawnWithStdin` from `planners/spawn.ts` to `utils/process.ts` as the unified base, with optional features (timeout, detached, conditional stdin).

**Rationale**: `spawnWithStdin` already has the most complete feature set: stdin pipe, line buffering, raw text accumulation, stderr collection, ENOENT handling, exit code 127 handling, activeProcesses tracking. It needs only 3 additions to cover all use cases: timeout, detached mode, and conditional stdin. `spawnWithStreaming` becomes a thin wrapper.

**Alternatives considered**:
- Enhance `spawnWithStreaming` instead — rejected because it lacks stdin, raw text, ENOENT custom messages, and exit code 127 handling. Too much to add.
- Create a brand new function — rejected because `spawnWithStdin` is 90% there already.
- Keep separate implementations — rejected because 5 copies of the same pattern creates maintenance drift.

**Unified API**:
```
spawnProcess(opts): Promise<SpawnProcessResult>
  - command, args, cwd (required)
  - stdin?: string (optional content to pipe)
  - stdinMode?: 'pipe' | 'ignore' (default 'pipe')
  - onLine: (line) => void (line-buffered stdout)
  - onStderr?: (chunk) => void
  - notFoundMessage?: string
  - timeout?: number (ms, 0 = none)
  - detached?: boolean
  - killEscalationDelay?: number (ms before SIGKILL, default 5000)
```

**Migration path**:
1. Create `spawnProcess` in `utils/process.ts`
2. Update `planners/spawn.ts` to re-export from `utils/process.ts`
3. Migrate each consumer one at a time
4. Remove old implementations after all consumers migrated
5. Keep `spawnWithStreaming` as a thin convenience wrapper

## 3. SIGKILL Escalation Pattern

**Decision**: Add SIGKILL escalation to `killProcess` in `utils/process.ts`, matching the pattern from `agent.ts`.

**Rationale**: The existing `killProcessGroup` function in `agent.ts` (lines 50-61) implements the correct pattern: SIGTERM → 5s delay → probe with signal 0 → SIGKILL. This should be the default for all subprocess cleanup via `killProcess`, not just agent subprocesses.

**Pattern**:
1. Guard: exit early if no PID or process already exited
2. Send SIGTERM
3. After 5s, probe with signal 0 (check if alive)
4. If still alive, send SIGKILL
5. All calls wrapped in try/catch for race safety

## 4. `emitGenEvent` Shared Helper

**Decision**: Extract `createGenEventEmitter(onEvent, model, file)` as a shared factory function.

**Rationale**: All three implementer backends define identical closures. The OpenAI backend's `extra` spread parameter covers all use cases. The factory captures `startTime` at creation, eliminating the need for callers to track it.

**Location**: `src/engine/implementer.ts` (co-located with the routing logic that dispatches to backends).

## 5. Post-Completion Pipeline

**Decision**: Extract a shared `processImplementerOutput(text, task, projectDir, emitGenEvent)` helper for the extract→apply→diff→emit pipeline.

**Rationale**: The OpenAI backend has the full pipeline (read old → extract → apply → diff → emit). The shell backend duplicates extract+apply but omits diff. The agent backend skips extract+apply entirely (it modifies files directly via subprocess). A shared helper for the extract+apply+diff path ensures all non-agent backends emit consistent diff data.

**The agent backend is excluded** from this helper because it doesn't use extract/apply — it could use `git diff` to compute diffs post-hoc, but that's a separate concern.

## 6. React Picker Refactoring

**Decision**: Replace 5 chained `useEffect` hooks with eager state initialization (`useState` initializer) + a single `useEffect` for side effects.

**Rationale**: The auto-selection logic is deterministic based on props at mount time. The 5-effect chain requires 2+ render cycles for auto-selection, uses guard refs (`errorFired`, `completeFired`) to prevent double-firing, and creates implicit state dependencies across render cycles. An eager `useState` initializer computes the correct initial `step` and `selectedPlanner`, then a single `useEffect` fires `onComplete`/`onError` based on that state.

**Pattern**:
```
useState initializer:
  - If 0 planners: step='error'
  - If 1 planner + 0 models: step='done', selectedPlanner=planner
  - If 1 planner + 1 model: step='auto-complete', selectedPlanner=planner
  - If 1 planner + N models: step='implementer', selectedPlanner=planner
  - Else: step='planner'

Single useEffect:
  - If step='error': onError(message)
  - If step='auto-complete': onComplete(planner, provider, model)
  - If step='done': onComplete(planner, DEFAULT_PROVIDER, DEFAULT_MODEL)
```

**The `useMemo` fix**: The `availableImplementers` array created by `.filter()` produces a new reference every render, defeating `useMemo`. Fix by using the stable `implementers` prop as the dependency and filtering inside the memo callback.

## 7. `useWorkflow` State Management

**Decision**: Recommend but defer `useReducer` migration to a future task. For this feature, focus on fixing the immediate bugs (missing "continue" handler, promise leak on `resetMode`).

**Rationale**: The `useReducer` migration touches the entire event handling flow and requires changing how `addEvent` is called from the orchestrator callbacks. The bug fixes (P1) can be done independently. The `useReducer` pattern is the right eventual design (7 coupled `useState` calls, event-driven with `type` discriminant), but coupling it with 30 other fixes risks regressions.

## 8. `useSessions` Pattern

**Decision**: Replace `useEffect` + `useState` with `useMemo` for the synchronous `listSessions` call.

**Rationale**: `listSessions` uses `readdirSync`/`readFileSync` — fully synchronous. The `useEffect` pattern causes an unnecessary initial render with `sessions=[]` and `loading=true`. `useMemo` makes sessions available on the first render and eliminates the `loading` state entirely. The `saveSession` mutation can trigger re-derivation via a `revision` counter.

## 9. Timer Leak Fix Pattern

**Decision**: Move `setTimeout` before event handler registration in `runCommand`, and guard it with a `settled` flag.

**Rationale**: The current code schedules `setTimeout` after the error handler, meaning a spawn ENOENT creates a timer that outlives the rejected promise by up to 60s. Moving the timer before handlers and clearing it in both `error` and `close` handlers prevents the leak. A `settled` flag prevents the timer callback from acting on an already-resolved promise.

## 10. Cost Breakdown Wiring

**Decision**: Populate `costBreakdown` in `buildSummary` and standardize percentage convention to 0-1 ratios.

**Rationale**: The `CostBreakdown` type, `calculateCostBreakdown` function, and `CostSection` UI component all exist but are disconnected. `localCompletionRate` uses 0-100 scale while `escalationRate` uses 0-1. Standardize on 0-1 (matching how the UI multiplies by 100 for display) and wire `calculateCostBreakdown` into `buildSummary`.

## 11. String.replace Dollar Substitution

**Decision**: Use function-form replacement: `result.replace(search, () => replace)`.

**Rationale**: JavaScript's `String.prototype.replace` with a string second argument interprets `$1`, `$&`, `$'`, `` $` ``, and `$$` as special substitution patterns. Code generated by AI frequently contains `${variable}` template literals, which would be corrupted to `{variable}` (the `$` is consumed as a failed `$` pattern match). The function form `() => replace` bypasses all special pattern interpretation.

## 12. Test Fixture Consolidation

**Decision**: Create `tests/helpers/fixtures.ts` exporting `makeConfig`, `makeTask`, `makeUsage`, and `defaultContext`.

**Rationale**: These factories are duplicated across 7+ test files with subtle inconsistencies (e.g., `orchestrator.test.ts` makeTask only takes `deps`, others take general overrides). A single source eliminates ~250 lines of duplication and ensures all tests use consistent default values. When a type changes (e.g., adding a field to `Config`), only one file needs updating.
