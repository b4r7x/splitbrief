# 006 — Soft Rewind Slash Commands

## Problem

Today, a user who realizes the spec or plan needs revision after it was approved has no ergonomic recovery path. They can:

- Reject at approval gate (only possible *before* approve).
- Manually edit `spec.md` / `plan.md` on disk and hope the planner re-reads it on the next escalation.
- Cancel and restart the whole workflow.

None of these is a one-command "redo this phase" flow.

Similarly, a task that succeeded validation but whose output is unsatisfactory has no way to be re-implemented short of manual git revert + restart.

Full Claude-Code-style message-level rewind is explicitly out of scope (`docs/FUTURE.md`). What we need is coarse-grained phase-level rewind via slash commands.

## Goal

Add three slash commands to the in-TUI command palette / slash suggestions:

- `/revise-spec [comment]` — rewind to `reviewing-spec`, regenerate spec with the optional comment as feedback.
- `/revise-plan [comment]` — rewind to `reviewing-plan`, regenerate plan.
- `/redo-task <id>` — reset a specific task's status to `pending` and rewind `currentTaskIndex` so the task loop re-picks it up.

## User stories

- **As a user realising after plan approval that "this should also handle refresh tokens"**, I type `/revise-spec use JWT with refresh tokens` and the workflow rewinds to reviewing-spec; the planner regenerates the spec incorporating my comment.
- **As a user mid-implementation finding task 5 didn't generate the code I wanted**, I type `/redo-task 5` and the task loop re-runs task 5 from scratch.
- **As a user on `diptych status` viewing a completed run**, these commands are not applicable and the command palette hides them.

## Functional requirements

**FR-001.** Three new entries in the slash-command registry (`src/core/commands/definitions.ts`):

| Command | Arguments | Available in phase |
|---------|-----------|---------------------|
| `/revise-spec` | optional text comment | any phase ≥ `reviewing-spec` and not terminal |
| `/revise-plan` | optional text comment | any phase ≥ `reviewing-plan` and not terminal |
| `/redo-task` | task-id (integer) | any phase ≥ `implementing` and not terminal |

**FR-002.** `/revise-spec <comment>` behaviour:
  1. If phase > `reviewing-spec`, emit `rewind_to_spec` event.
  2. Discard in-memory tasks (they depend on the old spec).
  3. Dispatch a new action `REWIND_TO_SPEC` that sets `phase: 'specifying'`, clears tasks, resets `currentTaskIndex` and `attempt`.
  4. If `comment` is non-empty, invoke `planner.regenerate('spec', buildRegeneratePrompt('spec', currentSpec, comment), …)` exactly like approval-gate commenting does today (`src/engine/orchestrator/approval.ts`).
  5. After regen, transition back to `reviewing-spec` via normal `SPEC_DONE`.

**FR-003.** `/revise-plan <comment>` is symmetric to FR-002 but for plan. Does NOT discard the spec. Does discard tasks.

**FR-004.** `/redo-task <id>` behaviour:
  1. Validate that task with the given id exists in `state.tasks`.
  2. Dispatch `RESET_TASK` action: set the task's `status` to `pending`, rewind `currentTaskIndex` to the task's position in the list.
  3. Next iteration of `runTaskLoop` picks the task up.
  4. If the task was previously committed (per-task commits on), we do NOT revert the commit. The implementer re-runs and may produce a different commit. User can manually reconcile.

**FR-005.** Commands are rejected with a clear error if run in an incompatible phase. Example: `/redo-task 3` in `researching` phase → `Error: /redo-task is only available after implementation begins.`

**FR-006.** State-machine additions:
- `REWIND_TO_SPEC` — sets `phase: 'specifying'`, `tasks: []`, `currentTaskIndex: 0`, `attempt: 0`.
- `REWIND_TO_PLAN` — sets `phase: 'planning'`, `tasks: []`, `currentTaskIndex: 0`, `attempt: 0`.
- `RESET_TASK` — sets one task's status to `pending`, rewinds `currentTaskIndex`.

**FR-007.** A new event type `rewind_to_spec | rewind_to_plan | task_reset` is emitted to `session.jsonl` before the state transitions, so the audit trail is clear.

**FR-008.** The slash-command palette (`src/components/input-bar/slash-suggestions.tsx`) shows only commands valid in the current phase. Invalid commands are filtered out.

## Success criteria

- Typing `/revise-spec add httpOnly cookie flag` in `implementing` phase:
  - Emits `rewind_to_spec` event.
  - Tasks cleared.
  - Phase becomes `specifying`.
  - Planner regenerates spec with the comment as feedback.
  - User lands at `reviewing-spec` approval gate.
- `/redo-task 3` in `implementing` phase with `currentTaskIndex: 5`:
  - Task 3 status becomes `pending`.
  - `currentTaskIndex` becomes 3.
  - Next loop iteration re-runs task 3.
- Slash suggestions show/hide based on current phase.
- All tests pass; new tests for each command's state transitions.

## Non-goals

- Undoing git commits produced by redone tasks (user reconciles manually).
- Restoring previous spec/plan content if user regrets the revision (that's message-level rewind, deferred).
- Rewinding past the feature prompt (no command like `/restart`). User uses `diptych start ...` for that.
- Batch operations (`/redo-task 3,4,5`) — single id only.
- Rewinding across sessions. These commands only operate on the active session.
