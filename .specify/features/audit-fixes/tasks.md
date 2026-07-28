# Tasks: Audit Fixes (2026-05-27)

**Source**: `docs/audits/full-codebase-audit-2026-05-26.md` (~450 findings, 61 agents)
**Spec**: `docs/specs/audit-fixes-spec-2026-05-27.md`
**Scope**: 6 critical bugs, ~57 high, systemic medium refactors = ~120 items across 8 phases

## Format: `[ID] [P?] [Phase] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Phase]**: P0a, P0b, P1, P2, P3, P4, P5, P6
- Each task has exact file paths and a concrete "done" condition

## Global Rules (propagate to EVERY subagent)

> **NEVER run `git commit`, `git add`, `git stage`.** A hook blocks with exit-2. Leave ALL changes unstaged.
>
> **Run `npm run test-ci`** after each phase. Fix regressions before declaring done.
>
> **Preserve invariants**: Zero `index.ts` barrels in `src/`, zero `useMemo`/`useCallback`/`React.memo`, zero engine→react imports, ESM `.js` extensions, kebab-case files, zero runtime classes.
>
> **When a fix changes behavior**, update tests to assert NEW behavior. Do NOT loosen assertions.

---

## Phase 1: P0a — Critical Bugs & Security

**Goal**: Fix 2 critical data-corruption bugs + 4 secret-leakage paths + 1 circular dep + 2 snapshot bugs.

**Independent Test**: `npm run test-ci` passes. Grep checks below return 0 lines.

### Implementation

- [ ] T001 [P0a] Fix `String.replace` → `replaceAll` in `src/engine/implementers/apply.ts:59` to patch ALL occurrences, not just first
  - **Done when**: `grep -n '\.replace(' src/engine/implementers/apply.ts | grep -v replaceAll | grep -v '//'` returns 0 lines

- [ ] T002 [P0a] Fix SKIP_TASK handler in `src/core/state/machine.ts:248-254` — set `phase: 'implementing'`, `attempt: 0` on SKIP_TASK transition
  - **Done when**: SKIP_TASK case sets both fields; existing tests updated to assert new behavior

- [ ] T003 [P] [P0a] Replace `String(err)` with `toErrorMessage(err)` in `src/features/workflow/hooks/use-workflow-runner.ts:190`
  - **Done when**: `grep -n 'String(err)' src/features/workflow/hooks/use-workflow-runner.ts` returns 0 lines

- [ ] T004 [P] [P0a] Replace raw `err.message` with `toErrorMessage(err)` in crash handler at `src/engine/ipc/server-entry.ts:135` (line 131 already does this correctly — match that pattern)
  - **Done when**: `grep -n 'err\.message' src/engine/ipc/server-entry.ts` returns 0 lines outside of `toErrorMessage`

- [ ] T005 [P] [P0a] Wrap socket error with `toErrorMessage(err)` in `src/engine/ipc/server.ts:280` before forwarding to event bus
  - **Done when**: Line ~280 uses `toErrorMessage`

- [ ] T006 [P] [P0a] Wrap messages with `redactSecrets()` in `src/engine/events/sinks/otel.ts:158,164` before forwarding to OTEL collector
  - **Done when**: `grep -n 'event\.message' src/engine/events/sinks/otel.ts` shows all wrapped in `redactSecrets()`

- [ ] T007 [P0a] Move `HEARTBEAT_INTERVAL_MS` from `src/engine/ipc/constants.ts` to new `src/engine/constants.ts`. Update imports in `src/engine/orchestrator/planning/heartbeat.ts` and `src/engine/ipc/server-entry.ts`
  - **Done when**: `grep -n "from.*ipc/" src/engine/orchestrator/planning/heartbeat.ts` returns 0 lines

- [ ] T008 [P0a] Fix Windows path separator bypass in `src/engine/snapshots/store.ts:119-121` — normalize path separators before split (use `path.sep` or `.split(/[/\\]/)`)
  - **Done when**: `rel.split('/')` no longer assumes forward slash only

- [ ] T009 [P0a] Fix `checkIgnoredPaths` ARG_MAX bypass in `src/engine/snapshots/store.ts:133-142` + `src/lib/git.ts:113-118` — use `git check-ignore --stdin` or batch into chunks
  - **Done when**: Large path lists don't silently return empty array

### Checkpoint P0a

```bash
npm run test-ci
grep -n '\.replace(' src/engine/implementers/apply.ts | grep -v replaceAll | grep -v '//'  # → 0 lines
grep -n 'String(err)' src/features/workflow/hooks/use-workflow-runner.ts  # → 0 lines
grep -n 'err\.message' src/engine/ipc/server-entry.ts  # → 0 lines outside toErrorMessage
grep -n "from.*ipc/" src/engine/orchestrator/planning/heartbeat.ts  # → 0 lines
find src -name 'index.ts' | head -1  # → empty
```

---

## Phase 2: P0b — Correctness & State Machine

**Goal**: Fix performance data-corruption bug, IPC hang, race condition, and 7 state machine issues (all in `core/state/machine.ts`).

**Depends on**: P0a complete

**Independent Test**: `npm run test-ci` passes. State machine tests updated.

### Implementation

- [ ] T010 [P0b] Add subscription guard in `src/engine/orchestrator/run/init.ts:107-117` — check if sinks already registered before subscribing, or unsubscribe old sinks first. This prevents N duplicate JSONL/tree-recorder/hook writes after N recovery iterations.
  - **Done when**: `grep -n 'subscribe\|addSink' src/engine/orchestrator/run/init.ts` shows guard logic (if-check or unsubscribe-before-subscribe)

- [ ] T011 [P0b] Add 30s timeout to pending prompt promises in `src/engine/ipc/server.ts:323-354`. When timeout fires, reject with a recoverable error so workflow doesn't hang forever on client disconnect.
  - **Done when**: Timeout mechanism visible in server.ts prompt handling

- [ ] T012 [P0b] Serialize state access in `src/engine/orchestrator/queue.ts:44-71` — prevent `getState()`/`setState()` race between queue handler and orchestrator that loses user messages
  - **Done when**: State mutations go through a single serialized writer (mutex, queue, or atomic update pattern)

- [ ] T013 [P0b] **STATE MACHINE BATCH** — Apply all 7 fixes to `src/core/state/machine.ts` as a single coordinated edit:
  - SM-W5-1: CANCEL/REJECT_SPEC/REJECT_PLAN/REJECT_BRIEFS/CONSTITUTION_CHECK_FAIL → clear `tasks: []`, `currentTaskIndex: 0`, `attempt: 0`
  - SM-W5-2: REWIND_TO_SPEC/REWIND_TO_PLAN → clear `clarifications: []`, `constitutionFailureReason: undefined`, `analysisResult: undefined`, `discoveredValidation: undefined`
  - SM-W5-3: REWIND_TO_SPEC/REWIND_TO_PLAN → set `plannerSessionId: undefined`
  - SM-W5-4: Remove `APPROVE_PLAN` action handler entirely (dead code — never dispatched)
  - SM-W5-5: Remove `FULL_FAIL` action handler entirely (dead code — contradicts actual behavior)
  - SM-W5-6: Restrict `VALIDATION_FAIL` — only allow from `validating-task`, NOT from `implementing`
  - SM-W5-7: Restrict `ESCALATE` — only allow from `validating-task`, NOT from `implementing`
  - **Done when**: All 7 sub-fixes applied. `grep "'APPROVE_PLAN'\|'FULL_FAIL'" src/core/state/machine.ts` → 0 lines

- [ ] T014 [P0b] Update state machine tests in `src/core/state/machine.test.ts` to assert the NEW behavior from T013. Delete tests that only assert the old (incorrect) behavior. Add tests for: SKIP_TASK resets phase, CANCEL clears tasks, REWIND clears stale fields, VALIDATION_FAIL rejected from implementing.
  - **Done when**: `npm run test-ci` passes with updated assertions

### Checkpoint P0b

```bash
npm run test-ci
grep -n "'APPROVE_PLAN'\|'FULL_FAIL'" src/core/state/machine.ts  # → 0 lines
grep -B5 'VALIDATION_FAIL' src/core/state/machine.ts | grep -i 'implementing'  # → 0 lines
grep -B5 "'ESCALATE'" src/core/state/machine.ts | grep -i 'implementing'  # → 0 lines
grep -A20 'REWIND_TO_SPEC\|REWIND_TO_PLAN' src/core/state/machine.ts | grep 'plannerSessionId\|clarifications'  # → shows reset
```

---

## Phase 3: P1 — Canonical Helpers & Shared Types

**Goal**: Create reusable helpers and types that Phase 4+ will consume. Extract duplicated patterns.

**Depends on**: P0b complete

### New Files

- [ ] T015 [P] [P1] Create `src/core/types/session-ref.ts` — export `type SessionRef = { projectDir: string; sessionId: string }`
  - **Done when**: File exists, exports SessionRef type

- [ ] T016 [P] [P1] Create `src/engine/types/bus-context.ts` — export `type BusContext = { bus: EventBus; phase: Phase }` (import EventBus and Phase from their canonical locations)
  - **Done when**: File exists, exports BusContext type

- [ ] T017 [P] [P1] Add shared Zod enums to `src/core/schemas/enums.ts`:
  - `FileActionSchema = z.enum(['create', 'modify'])` (currently defined independently in `core/schemas/task.ts:32`, `core/sessions/tree/entry-types.ts:16`, `engine/spec/parser.ts:20`)
  - `ValidationStageSchema = z.enum(['typecheck', 'lint', 'test'])` (currently in `core/schemas/evidence.ts:25`, `engine/mcp/tool/schemas.ts:29`)
  - **Done when**: `grep -rn "z\.enum.*create.*modify" src/ | grep -v enums.ts | grep -v test` → 0 lines

### New Helpers

- [ ] T018 [P] [P1] Add `rethrowAsCli(err: unknown): never` to `src/cli/errors.ts`. Body: `if (isCliError(err)) throw err; throw cliError(toErrorMessage(err), 1);`
  - **Done when**: Function exported from `src/cli/errors.ts`

- [ ] T019 [P1] Replace all 13+ `if (isCliError(err)) throw err; throw cliError(...)` catch blocks in `src/cli/commands/` with `rethrowAsCli(err)`. Files: `snapshot.ts` (x5), `explain.ts`, `stats.ts`, `mcp.ts` (x2), `approval.ts` (x2), `export.ts`, `handoff.ts`, `detach.ts`, `worktree.ts`
  - **Depends on**: T018
  - **Done when**: `grep -rn 'if (isCliError(err)) throw err; throw cliError' src/cli/commands/` → 0 lines

- [ ] T020 [P] [P1] Add `detectProjectLanguage(projectDir: string)` to `src/core/project-meta.ts` — extract the Cargo.toml → go.mod → pyproject.toml → package.json cascade from `engine/spec/prompts/language-context.ts:99-113` and `engine/orchestrator/validation-heuristic.ts:5-46`
  - **Done when**: Function exported; both duplicate files import it

- [ ] T021 [P1] Replace duplicate language detection in `src/engine/spec/prompts/language-context.ts` and `src/engine/orchestrator/validation-heuristic.ts` with `detectProjectLanguage` from T020
  - **Depends on**: T020
  - **Done when**: `grep -rn "Cargo\.toml.*go\.mod\|go\.mod.*Cargo\.toml" src/ | grep -v project-meta | grep -v test` → 0 lines

- [ ] T022 [P] [P1] Export `taskIdToString(id: TaskId): string` from `src/core/schemas/task.ts` (branded-type-safe unwrap)
  - **Done when**: Function exported

- [ ] T023 [P1] Replace `const taskKey = (id: TaskId): string => id as string` in `src/engine/events/sinks/otel.ts:21` and `const tid = (id: TaskId): string => id as string` in `src/engine/events/sinks/tree-recorder.ts:22` with import of `taskIdToString`
  - **Depends on**: T022
  - **Done when**: `grep -rn 'as string' src/engine/events/sinks/otel.ts src/engine/events/sinks/tree-recorder.ts | grep -i taskid` → 0 lines

- [ ] T024 [P] [P1] Add `pluralize(n: number, singular: string, plural?: string): string` to `src/utils/format.ts` (or appropriate existing util file). Default plural appends 's'.
  - **Done when**: Function exported, with a colocated test

- [ ] T025 [P] [P1] Add `isNonNull<T>(x: T | null | undefined): x is T` to `src/utils/type-guards.ts`
  - **Done when**: Function exported

- [ ] T026 [P1] Replace 4 hand-rolled package.json reads with `readPackageJson(projectDir)` from `src/core/project-meta.ts`. Locations: `engine/spec/prompts/language-context.ts:104-113`, `engine/orchestrator/validation-heuristic.ts:33-43`, `core/readiness/collect.ts:125-149`, `core/paths-io.ts:18-25`
  - **Done when**: `grep -rn "readFileSync.*package\.json" src/engine/ src/core/readiness/ src/core/paths-io.ts | grep -v project-meta` → 0 lines

- [ ] T027 [P1] Replace 4 hand-rolled line buffers with `createLineBuffer` from `src/lib/process/line-buffer.ts`. Locations: `cli/commands/detach.ts:56-68`, `features/workflow/hooks/use-ipc-client.ts:111-130`, `engine/ipc/server.ts:153-176`, `engine/ipc/server.ts:235-252`
  - **Done when**: `grep -rn "let buffer\|let chunk\|let partial" src/cli/commands/detach.ts src/features/workflow/hooks/use-ipc-client.ts src/engine/ipc/server.ts | grep -vi import` → 0 lines

- [ ] T028 [P1] Replace 2 atomic write reimplementations with `writeSecureFile` from `src/lib/fs.ts`. Locations: `core/stats/persistence.ts:28-33`, `core/sessions/tree/io.ts:26-33`
  - **Done when**: Both files import and use `writeSecureFile`

- [ ] T029 [P] [P1] Extract `resolveRunningSession` from `src/cli/commands/attach.ts:32-45` and `detach.ts:23-33` into shared helper in `src/cli/commands/shared.ts` (or `src/cli/session-resolve.ts`)
  - **Done when**: Both files import from shared location; no near-duplicate logic

- [ ] T030 [P] [P1] Extract `assertResumableState(state, sessionId)` from `src/cli/commands/continue.ts:119-137` and `resume.ts:36-48` into shared helper
  - **Done when**: Both files import from shared location

- [ ] T031 [P] [P1] Extract shared `retryCountsFromEvents` from `src/engine/orchestrator/evidence/review-packet/sections.ts:321` and `src/engine/orchestrator/explain/sections.ts:192` into `src/engine/orchestrator/evidence/retry-counts.ts`
  - **Done when**: Both files import from shared location

- [ ] T032 [P] [P1] Extract `findUnusedId(root, base, suffixer)` from `src/core/sessions/lifecycle.ts:39-48` and `core/migration/legacy.ts:10,18-24`
  - **Done when**: Both files import from shared location

- [ ] T033 [P] [P1] Extract `accumulateProviderCosts(target, source)` from `src/core/sessions/analytics.ts:41-48` and `core/stats/persistence.ts:65-72`
  - **Done when**: Both files import from shared location

### Checkpoint P1

```bash
npm run test-ci
grep -rn 'if (isCliError(err)) throw err; throw cliError' src/cli/commands/  # → 0 lines
grep -rn "readFileSync.*package\.json" src/engine/ src/core/readiness/ src/core/paths-io.ts | grep -v project-meta  # → 0 lines
grep -rn "z\.enum.*create.*modify" src/ | grep -v enums.ts | grep -v test  # → 0 lines
grep -rn 'as string' src/engine/events/sinks/otel.ts src/engine/events/sinks/tree-recorder.ts | grep -i taskid  # → 0 lines
```

---

## Phase 4: P2 — Parameter Design Refactors

**Goal**: Convert functions with 6+ positional params to options objects. Use `BusContext` and `SessionRef` from P1.

**Depends on**: P1 complete (needs BusContext, SessionRef types)

### Implementation

- [ ] T034 [P2] Refactor `runHeadless` in `src/cli/headless.ts:44-53` from 9 positional params to single `RunHeadlessOptions` object. Update ALL callers.
  - **Done when**: `grep -n 'runHeadless.*undefined.*undefined' src/` → 0 lines; function takes 1 param

- [ ] T035 [P2] Refactor `runRpc` in `src/cli/rpc/run.ts:72-83` from 10 positional params to single `RunRpcOptions` object. Update ALL callers.
  - **Done when**: Function takes 1 param

- [ ] T036 [P] [P2] Refactor `calculateTaskUsageCost` in `src/engine/providers/pricing.ts:242-250` from 7 positional params to options object. Update ALL callers.
  - **Done when**: Function takes 1 param

- [ ] T037 [P] [P2] Refactor `publishEscalate` in `src/engine/orchestrator/events.ts:114` from 7 positional params to options object (use `BusContext` for `bus`+`phase`). Update ALL callers.
  - **Done when**: Function takes 1 param using BusContext

- [ ] T038 [P] [P2] Refactor `handleConversationScroll` in `src/features/workflow/keyboard.ts:59` from 6 positional params to options object. Update ALL callers.
  - **Done when**: Function takes 1 param

- [ ] T039 [P] [P2] Refactor `getWorkflowContentRect` in `src/core/layout/workflow-rect.ts:43` from 6 positional params to `WorkflowContentRectInput` object. Update ALL callers.
  - **Done when**: Function takes 1 param

- [ ] T040 [P] [P2] Refactor `formatNode` in `src/features/tree-view/format.ts:31-38` from 6 positional params to `FormatNodeArgs` object. Update ALL callers.
  - **Done when**: Function takes 1 param

- [ ] T041 [P2] Refactor ~20 `(bus, phase, ...)` publish functions in `src/engine/orchestrator/events.ts` to accept `BusContext` as first param instead of separate `bus` and `phase` args. Update ALL callers across `src/engine/orchestrator/`.
  - **Depends on**: T016 (BusContext type)
  - **Done when**: `grep -c 'bus: EventBus, phase: Phase' src/engine/orchestrator/events.ts` → 0 lines

- [ ] T042 [P2] Refactor ~15 `(projectDir, sessionId, ...)` functions across 6 files to accept `SessionRef` as first param. Candidates: functions in `core/sessions/`, `core/stats/`, `cli/commands/` that take both params positionally.
  - **Depends on**: T015 (SessionRef type)
  - **Done when**: Target functions take SessionRef instead of 2 separate string params

### Checkpoint P2

```bash
npm run test-ci
grep -A3 'function runHeadless\|export.*runHeadless' src/cli/headless.ts | head -5  # single param
grep -A3 'function runRpc\|export.*runRpc' src/cli/rpc/run.ts | head -5  # single param
grep -c 'bus: EventBus, phase: Phase' src/engine/orchestrator/events.ts  # → 0
grep -n 'runHeadless.*undefined.*undefined' src/  # → 0 lines
```

---

## Phase 5: P3 — SRP Splits

**Goal**: Split oversized files (300+ LOC with mixed concerns) into focused modules.

**Depends on**: P2 complete

### Implementation

- [ ] T043 [P3] Extract escalation logic from `src/engine/planners/base.ts` (413 LOC) into new `src/engine/planners/escalation.ts` (escalateHint, escalateFull) and `src/engine/planners/summary.ts` (summarize, summarizeStructured). Update imports.
  - **Done when**: `wc -l src/engine/planners/base.ts` < 250; new files exist; imports updated

- [ ] T044 [P3] Split `src/engine/ipc/server.ts` (379 LOC) into:
  - `src/engine/ipc/replay-session.ts` (session replay logic)
  - `src/engine/ipc/control-detach.ts` (control-channel detach)
  - `src/engine/ipc/prompt-tracker.ts` (prompt correlation)
  - **Done when**: `wc -l src/engine/ipc/server.ts` < 200; 3 new files exist; imports updated

- [ ] T045 [P3] Extract from `src/features/workflow/hooks/use-ipc-client.ts` (284 LOC):
  - `createIpcConnection(opts)` helper function
  - `handleServerMessage(msg, callbacks)` helper function
  - **Done when**: Hook file < 150 LOC; helpers extracted

- [ ] T046 [P3] Extract readiness fetch from `src/features/workflow/screen.tsx` (266 LOC) into new `src/features/workflow/hooks/use-readiness-fetch.ts` hook
  - **Done when**: screen.tsx < 200 LOC; hook file exists

- [ ] T047 [P3] Extract shared `CompletionPanel` shell component from `src/components/composer/completion/command/menu.tsx` and `reference/menu.tsx` into `src/components/composer/completion/completion-panel.tsx`. Use `renderRow` callback for differences.
  - **Done when**: New file exists; both menus import it; duplicate structure eliminated

- [ ] T048 [P3] Extract `useCompletionSelection` hook from `src/components/composer/completion/command/hook.ts` and `reference/hook.ts` into `src/components/composer/completion/use-completion-selection.ts`
  - **Done when**: New file exists; both hooks import it; duplicate SelectionState/handlers eliminated

- [ ] T049 [P3] Consolidate `src/engine/orchestrator/escalation/` — merge 3 structurally identical tier files (tier0.ts, tier1.ts, tier2.ts) into single `src/engine/orchestrator/escalation/run-escalation-tier.ts` with config parameter
  - **Done when**: Single file handles all tiers; old tier files removed; `npm run test-ci` passes

### Checkpoint P3

```bash
npm run test-ci
wc -l src/engine/ipc/server.ts  # < 200
wc -l src/engine/planners/base.ts  # < 250
test -f src/engine/ipc/replay-session.ts && echo OK  # OK
test -f src/engine/ipc/control-detach.ts && echo OK  # OK
test -f src/engine/ipc/prompt-tracker.ts && echo OK  # OK
test -f src/engine/planners/escalation.ts && echo OK  # OK
test -f src/components/composer/completion/completion-panel.tsx && echo OK  # OK
find src -name 'index.ts'  # → empty
grep -rn "from 'react'\|from 'ink'" src/engine/ | grep -v test  # → empty
```

---

## Phase 6: P4 — Type Safety

**Goal**: Replace unsafe casts with Zod validation, add exhaustiveness checks, narrow wide types.

**Depends on**: P3 complete

### Implementation

- [ ] T050 [P4] Replace shallow `as ServerMessage` casts in `src/engine/ipc/protocol.ts:151-157` with Zod discriminated union parse for ServerMessage variants
  - **Done when**: `grep -n 'as ServerMessage' src/engine/ipc/protocol.ts` → 0 lines

- [ ] T051 [P4] Replace cascading `as` casts in `src/engine/ipc/replay.ts:19,25,40` with Zod discriminated union parse for EngineEvent deserialization
  - **Done when**: `grep -c ' as ' src/engine/ipc/replay.ts` ≤ 1 (down from 3+)

- [ ] T052 [P] [P4] Fix double cast in `src/engine/providers/openai-stream.ts:144,146` — introduce thin adapter mapping SDK chunks to StreamChunk type
  - **Done when**: No double assertion chain

- [ ] T053 [P] [P4] Validate dynamic import return in `src/engine/handoff/load-renderer.ts:25,29` with HandoffPack Zod schema instead of cast after `typeof fn === 'function'`
  - **Done when**: Uses Zod validation instead of `as RendererFunction`

- [ ] T054 [P] [P4] Replace `input as HandoffInput` in `src/engine/handoff/render.ts:70,91` with type predicate function for target narrowing
  - **Done when**: Uses type predicate, no `as HandoffInput` cast

- [ ] T055 [P] [P4] Define Zod schema for JSON-RPC params in `src/engine/mcp/handlers.ts:69,152` — replace `msg['params'] as Record<string, unknown>` on untrusted MCP input
  - **Done when**: `grep -n 'as Record' src/engine/mcp/handlers.ts` → 0 lines

- [ ] T056 [P] [P4] Add `default: assertNever(action)` to `viewReducer` switch in `src/features/runners/view-state.ts:23-31`
  - **Done when**: `grep -n 'assertNever' src/features/runners/view-state.ts` → 1 line

- [ ] T057 [P] [P4] Add exhaustiveness check to `updateTokens` switch in `src/stores/workflow/tokens.ts:104`
  - **Done when**: `grep -n 'assertNever' src/stores/workflow/tokens.ts` → 1 line

- [ ] T058 [P] [P4] Add exhaustiveness checks to event type switches in `src/engine/events/sinks/otel.ts:24` and `src/engine/events/sinks/tree-recorder.ts:37`
  - **Done when**: `grep -n 'assertNever' src/engine/events/sinks/otel.ts src/engine/events/sinks/tree-recorder.ts` → 2 lines

- [ ] T059 [P4] Narrow `phase: string` leaks to `Phase` type at 6 sites: `PlannerCallbacks.onPhase`, `phaseCostRole`, `WorktreeInfo.phase`, `RunExplain.phase`, `runPhase` in base.ts, `spec.ts` CLI handler
  - **Done when**: `grep -rn 'phase: string' src/ | grep -v test | grep -v node_modules | grep -v '.d.ts'` → 0 lines

- [ ] T060 [P4] Narrow `mode: string` leaks to `WorkflowMode` type at 3 sites: `SpecMetadata.mode`, `IpcServerArgs.mode`, `SessionRow.mode`
  - **Done when**: `grep -rn 'mode: string' src/ | grep -v test | grep -v node_modules` → 0 lines (for the target sites)

### Checkpoint P4

```bash
npm run test-ci
grep -n 'as ServerMessage' src/engine/ipc/protocol.ts  # → 0 lines
grep -c ' as ' src/engine/ipc/replay.ts  # ≤ 1
grep -rn 'assertNever' src/features/runners/view-state.ts src/stores/workflow/tokens.ts src/engine/events/sinks/otel.ts src/engine/events/sinks/tree-recorder.ts  # → 4 lines
grep -rn 'phase: string' src/ | grep -v test | grep -v node_modules | grep -v '.d.ts'  # → 0 lines
```

---

## Phase 7: P5 — Dead Code Purge

**Goal**: Remove orphaned files, dead functions, dead event types, unused exports.

**Depends on**: P4 complete

### Implementation

- [ ] T061 [P] [P5] Delete orphaned file `src/engine/orchestrator/explain/types.ts` (89 lines, zero imports)
  - **Done when**: File does not exist

- [ ] T062 [P] [P5] Delete entire `src/features/tree-view/` directory (303 lines, 4 files: `tree-view.tsx`, `tree-node.tsx`, `tree-store.ts`, `format.ts` — no production consumer)
  - **Done when**: Directory does not exist

- [ ] T063 [P5] Remove 8 dead EngineEvent types from the union in `src/engine/events/types.ts`: `research_done`, `spec_done`, `spec_approved`, `plan_done`, `task_failed`, `server_crash_detected`, `server_post_mortem_shown`, `planner_attachment_added`. Then remove ALL dead consumer branches across ~10 files: `renderable-conversation.ts`, `event-types.ts`, `event-card.tsx`, `event-role.ts`, `simple-cards.tsx`, `task-cards.tsx`, `otel.ts`, `tree-recorder.ts`, `explain/sections.ts`, `stores/workflow/tasks.ts`
  - **Done when**: `grep -n "'research_done'\|'spec_done'\|'spec_approved'\|'plan_done'\|'task_failed'\|'server_crash_detected'\|'server_post_mortem_shown'\|'planner_attachment_added'" src/engine/events/types.ts` → 0 lines

- [ ] T064 [P5] Remove `post_planning` hook mapping at `src/engine/hooks/sink.ts:68` (maps to never-emitted `plan_done`). Remove any documentation referencing `post_planning` hook lifecycle event.
  - **Done when**: `grep -n 'post_planning\|plan_done' src/engine/hooks/sink.ts` → 0 lines

- [ ] T065 [P] [P5] Remove 10 dead functions (and their exports):
  - `requestAttach` in `features/workflow/handlers.ts:70`
  - `requestDetach` in `features/workflow/handlers.ts:76`
  - `findLatestEventByType` in `core/layout/event-sections.ts:11`
  - `getSessionDir` in `core/sessions/io.ts:11`
  - `maskApiKey` in `utils/redact.ts:80`
  - `hasExternalChanges` in `lib/git.ts:81`
  - `getActiveProcessCount` in `lib/process/registry.ts:17`
  - `parseModelId` in `engine/providers/model/parsing.ts:46`
  - `buildImplementationErrorRecoveryIssue` in `engine/orchestrator/recovery/builders/task.ts:56`
  - `buildValidationFailedRecoveryIssue` in `engine/orchestrator/recovery/builders/task.ts:102`
  - **Done when**: `grep -rn 'export.*requestAttach\|export.*requestDetach\|export.*findLatestEventByType\|export.*maskApiKey\|export.*hasExternalChanges\|export.*getActiveProcessCount\|export.*parseModelId\|export.*buildImplementationErrorRecoveryIssue\|export.*buildValidationFailedRecoveryIssue' src/` → 0 lines

- [ ] T066 [P] [P5] Remove 3 dead constants:
  - `IPC_PROTOCOL_VERSION` in `engine/ipc/protocol.ts:61`
  - `INTERNAL_ERROR` in `engine/mcp/handlers.ts:10`
  - `REVIEW_PACKET_ARTIFACTS` in `engine/orchestrator/evidence/review-packet/review-packet.ts:19`
  - **Done when**: `grep -rn 'IPC_PROTOCOL_VERSION\|INTERNAL_ERROR\|REVIEW_PACKET_ARTIFACTS' src/ | grep 'export\|const'` → 0 lines

- [ ] T067 [P] [P5] Remove 2 dead type exports from `src/engine/mcp/types.ts`: `McpRequest`, `McpNotification`
  - **Done when**: Types removed from file

- [ ] T068 [P5] Remove 2 duplicate type definitions from `src/engine/implementers/types.ts`: `ImplementerWriteMode` and `ImplementerCapabilities` (shadow canonical versions in `core/schemas/implementer-config.ts`). Update all imports to use canonical source.
  - **Done when**: `grep -n 'ImplementerWriteMode\|ImplementerCapabilities' src/engine/implementers/types.ts | grep 'type\|interface'` → 0 lines

- [ ] T069 [P] [P5] Remove unnecessary `export` keyword from 5 file-local symbols:
  - `splitbriefDir` in `core/paths.ts:11`
  - `applyEffortPrefix` in `engine/claude-invoke.ts:112`
  - `AdvisoryStore` in `engine/orchestrator/planning/mode-advisor.ts:244`
  - `createAdvisoryStore` in `engine/orchestrator/planning/mode-advisor.ts:250`
  - `BudgetRecoveryBoundary` in `engine/orchestrator/budget/budget.ts:15`
  - **Done when**: Each symbol no longer has `export` keyword; used only within own file

- [ ] T070 [P5] Verify dead actions `APPROVE_PLAN` and `FULL_FAIL` were removed in P0b (T013). If still present, remove now.
  - **Done when**: `grep "'APPROVE_PLAN'\|'FULL_FAIL'" src/core/state/machine.ts` → 0 lines

### Checkpoint P5

```bash
npm run test-ci
test ! -f src/engine/orchestrator/explain/types.ts && echo OK  # OK
test ! -d src/features/tree-view && echo OK  # OK
grep -n "'research_done'\|'spec_done'\|'spec_approved'\|'plan_done'" src/engine/events/types.ts  # → 0 lines
grep -rn 'IPC_PROTOCOL_VERSION' src/  # → 0 lines
grep -rn 'export.*requestAttach\|export.*maskApiKey\|export.*hasExternalChanges' src/  # → 0 lines
```

---

## Phase 8: P6 — Architecture Fixes

**Goal**: Fix layer violations, move misplaced code, establish proper facades.

**Depends on**: P5 complete

### Implementation

- [ ] T071 [P6] Move CLI presentation code from `src/engine/ipc/crash-diagnostic.ts:88-163` (box-drawing, raw stdin, `process.exit()`) to CLI layer. Create `src/cli/crash-diagnostic.ts` with `showCrashDiagnostic` and `waitForCrashDiagnosticOption`. Update imports.
  - **Done when**: `grep -n 'process\.exit\|rawMode' src/engine/ipc/crash-diagnostic.ts` → 0 lines

- [ ] T072 [P] [P6] Extract shared `attachImagesToLastUserMessage` from `src/engine/providers/openai-stream.ts:59-78` and `providers/anthropic/stream.ts:202-222` into shared helper (parameterized by block mapper) in `src/engine/providers/image-attach.ts`
  - **Done when**: Both files import from shared helper; duplicate algorithm eliminated

- [ ] T073 [P6] Move `SUMMARY_FILE` constant from `src/engine/orchestrator/explain/artifacts.ts` to `src/core/paths.ts` where all other path constants live. Update imports.
  - **Done when**: `grep -n 'SUMMARY_FILE' src/core/paths.ts` → 1+ lines

- [ ] T074 [P] [P6] Move `src/lib/availability.ts` to `src/engine/availability.ts` (used exclusively by engine). Update imports.
  - **Done when**: File in engine/; old location gone

- [ ] T075 [P] [P6] Move `src/core/brief-hash.ts` to `src/engine/brief-hash.ts` (used exclusively by engine). Update imports.
  - **Done when**: File in engine/; old location gone

- [ ] T076 [P6] Break 4 cross-store domain imports:
  - `stores/ui/attachments.ts` → `stores/workflow/attachments` — use event bus or shared type instead
  - `stores/discovery/detection-adapter.ts` → `stores/project/detection` — use shared type
  - `stores/ui/controls.ts` → `stores/navigation/router` — use shared type
  - `stores/navigation/router.ts` → `stores/ui/feedback` — use event or shared type
  - **Done when**: No store imports from sibling store domains

- [ ] T077 [P6] Create engine facade for recovery operations used by `src/features/workflow/hooks/use-recovery-driver.ts` (currently imports 6 engine modules directly). Create `src/engine/facades/recovery.ts` that re-exports the needed operations.
  - **Done when**: use-recovery-driver.ts imports from single facade, not 6 engine paths
  - **Note**: This is NOT a barrel file — it contains actual facade logic/type narrowing, not just re-exports

- [ ] T078 [P6] Extract shared command implementations from `src/app/command-context.ts` (TUI) and `src/cli/rpc/command-context.ts` (RPC) into a factory with thin adapter for projectDir/sessionId sourcing. Currently ~20 command implementations are duplicated.
  - **Done when**: Shared factory exists; both contexts use it; duplicate code eliminated

### Checkpoint P6

```bash
npm run test-ci
grep -n 'process\.exit\|rawMode' src/engine/ipc/crash-diagnostic.ts 2>/dev/null  # → 0 lines or file gone
grep -rn "from 'react'\|from 'ink'\|from '.*features/" src/engine/ | grep -v test  # → 0 lines
grep -n 'SUMMARY_FILE' src/core/paths.ts  # → 1+ lines
grep -n "from '.*workflow/" src/stores/ui/attachments.ts 2>/dev/null  # → 0 lines
find src -name 'index.ts'  # → empty
```

---

## Dependencies & Execution Order

### Phase Dependencies

```
P0a ──→ P0b ──→ P1 ──→ P2 ──→ P3 ──→ P4 ──→ P5 ──→ P6
                  │                              │
                  └─ creates helpers ─────────────┘ (consumed by P2+)
```

- **P0a** (bugs+security): No dependencies — start immediately
- **P0b** (state machine): Depends on P0a (BUG-2 partial fix there)
- **P1** (helpers): Depends on P0b (clean base to build on)
- **P2** (params): Depends on P1 (needs BusContext, SessionRef)
- **P3** (SRP): Depends on P2 (files stabilized after param changes)
- **P4** (types): Depends on P3 (files restructured, safe to add Zod)
- **P5** (dead code): Depends on P4 (can verify what's truly unused after type changes)
- **P6** (architecture): Depends on P5 (clean slate for moves)

### Within Each Phase

- Tasks marked **[P]** can run in parallel (different files, no deps)
- Tasks WITHOUT [P] are sequential — wait for deps
- **Always** run `npm run test-ci` at phase checkpoint before advancing

### Parallel Opportunities

**P0a**: T003, T004, T005, T006 can all run in parallel (different files)
**P1**: T015, T016, T017, T018, T020, T022, T024, T025, T029, T030, T031, T032, T033 can all run in parallel (new files/helpers)
**P4**: T052, T053, T054, T055, T056, T057, T058 can all run in parallel (different files)
**P5**: T061, T062, T065, T066, T067, T069 can all run in parallel (independent deletions)
**P6**: T072, T074, T075 can run in parallel (different file moves)

---

## Summary

| Phase | Tasks | Parallel | Focus |
|---|:---:|:---:|---|
| P0a | T001–T009 (9) | 4 | Critical bugs, security |
| P0b | T010–T014 (5) | 0 | State machine, perf, IPC |
| P1 | T015–T033 (19) | 13 | Helpers, types, DRY |
| P2 | T034–T042 (9) | 4 | Parameter design |
| P3 | T043–T049 (7) | 0 | SRP file splits |
| P4 | T050–T060 (11) | 7 | Type safety |
| P5 | T061–T070 (10) | 6 | Dead code purge |
| P6 | T071–T078 (8) | 3 | Architecture |
| **Total** | **78 tasks** | **37 parallelizable** | |
