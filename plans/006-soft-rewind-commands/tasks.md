# 006 — Soft Rewind Slash Commands — Tasks

## Phase 1 — State machine

### T001 — Add three new actions

**File:** `src/core/state/machine.ts`

Add `REWIND_TO_SPEC`, `REWIND_TO_PLAN`, `RESET_TASK` to the action union. Implement reducers per `plan.md`. Add `awaitingContinue: false` reset.

### T002 — Add three event types

**File:** `src/core/types/events.ts`

Add `rewind_to_spec`, `rewind_to_plan`, `task_reset` to the orchestrator event union with payload types (`{ comment?: string }` for rewinds, `{ taskId: TaskId }` for reset).

### T003 — Add renderer cards for the new events

**File:** `src/components/event-cards/index.tsx` (or per-type files)

Minimal cards: "Rewound to spec" / "Rewound to plan" / "Task N reset".

## Phase 2 — Phase guards

### T004 — `src/core/commands/phase-guards.ts`

Create the module per `plan.md` → "Phase guards". Export `canReviseSpec`, `canRevisePlan`, `canRedoTask`, plus a `phaseOrder(phase): number` helper. Colocate unit tests per phase transition.

## Phase 3 — Handlers

### T005 — `src/core/commands/handlers/revise-spec.ts`

Create per `plan.md` → "`/revise-spec`". Emits `rewind_to_spec`, dispatches `REWIND_TO_SPEC`, optionally calls `planner.regenerate` if comment provided.

### T006 — `src/core/commands/handlers/revise-plan.ts`

Symmetric. Emits `rewind_to_plan`, dispatches `REWIND_TO_PLAN`.

### T007 — `src/core/commands/handlers/redo-task.ts`

Per `plan.md`. Parses task-id, validates, dispatches `RESET_TASK`.

### T008 — Task-id parser

**File:** `src/core/commands/handlers/redo-task.ts` (or shared utils)

`parseTaskId(input: string): TaskId | null`. Accepts an integer; coerces to branded `TaskId`. Returns null on malformed input.

## Phase 4 — Registry

### T009 — Register three commands in `definitions.ts`

**File:** `src/core/commands/definitions.ts`

Add three new entries with `id`, `trigger`, `description`, `phaseGuard`, `handler`. Handler imports are the modules from Phase 3.

### T010 — Extend slash-suggestion filter

**File:** `src/components/input-bar/use-slash-autocomplete.ts`

Consult `phaseGuard(currentPhase)` when producing suggestions. Commands whose guard returns false are hidden.

## Phase 5 — Orchestrator integration

### T011 — Wire commands into workflow input handling

**File:** `src/hooks/use-workflow-review-input.ts` (or similar — grep for where slash commands are dispatched today)

When a slash command is entered during a live workflow, look up in the registry, call the handler with `CommandContext` (which includes `projectDir`, `sessionId`, `planner`, `state`, `callbacks`).

### T012 — Ensure task loop re-picks up reset tasks

**File:** `src/engine/orchestrator/task-loop.ts`

Confirm that after `RESET_TASK` dispatches and state is saved, the next loop iteration reads `currentTaskIndex` and finds the reset task. No new logic if today's loop is already stateless-per-iteration (should be).

## Phase 6 — Tests

### T013 — Phase-guard unit tests

Cover every phase × command combination in `canReviseSpec` etc.

### T014 — Handler unit tests

For each handler, assert:
- State transitions correctly after dispatch.
- Events emitted with correct payload.
- Planner.regenerate called exactly when comment non-empty.
- Error feedback set when taskId invalid.

### T015 — Slash-suggestion filter test

Mock workflowStore with `phase: 'researching'`. Call suggestion list provider. Assert rewind commands absent. Change to `phase: 'implementing'`. Assert all three present.

### T016 — Full test suite

`npm test` → green.

## Phase 7 — Doc Sync

### T017 — Update `docs/WORKFLOW.md` §1.1 "Slash-command actions"

Current section describes these three commands conceptually. Confirm implementation matches. Link to handler files.

### T018 — Update `docs/CONCEPTS.md`

Check if "Slash commands" section exists — if not, consider adding a paragraph under Workflow or Commands. Otherwise, no change.

### T019 — Update help text / command palette description

Each command's `description` field shows in the command palette overlay. Write short, clear descriptions:

- `/revise-spec [comment]` — "Rewind to spec stage and optionally regenerate with feedback"
- `/revise-plan [comment]` — "Rewind to plan stage"
- `/redo-task <id>` — "Reset a task to pending so the task loop re-runs it"
