# 004 — Persist Planner Session ID — Tasks

## Phase 1 — Rename + type changes

### T001 — Rename `sessionId` → `plannerSessionId` on `WorkflowState`

**Files:** `src/core/types/schemas/workflow.ts`, `src/core/state/machine.ts`, every consumer.

Grep for `state.sessionId` across `src/` and rename. Grep for `sessionId:` in type files — only touch `WorkflowState` context; do NOT rename the spec-002 diptych session-id (that's a separate variable named `sessionId` on `WorkflowContext`).

### T002 — Rename action `SET_SESSION_ID` → `SET_PLANNER_SESSION_ID`

**File:** `src/core/state/machine.ts` + any dispatcher. No current dispatchers (confirmed pre-spec), so the rename is symbolic — this spec will add the first real dispatch in T006.

### T003 — Bump `CURRENT_STATE_VERSION` from 2 to 3

**File:** `src/core/state/machine.ts:3`

Loading an older state (v2) fails with the existing version check. Spec 009 handles the migration story.

### T004 — Add `onSessionId` to `PlannerCallbacks` interface

**File:** `src/engine/planners/types.ts`

Add `onSessionId?: (sessionId: string) => void;` to the `PlannerCallbacks` interface.

## Phase 2 — Planner wiring

### T005 — Accept `initialSessionId` in Claude Code planner factory

**File:** `src/engine/planners/claude-code.ts`

Change `createClaudeCodePlanner(model?: string)` → `createClaudeCodePlanner(model?: string, initialSessionId?: string | null)`. Seed the `currentSessionId` closure variable with `initialSessionId ?? null`.

### T006 — Dispatch `onSessionId` after each Claude stream

**File:** `src/engine/planners/claude-code.ts` + `src/engine/claude-runner.ts`

Claude-runner already reports `session_id` via `onSessionId` callback in the stream-json parser (`src/engine/claude-runner.ts:66`). The planner wrapper needs to forward this to `callbacks.onSessionId` provided by the orchestrator. Update `invokePlan` / `invokeEscalate` paths in `claude-code.ts` to wire this through.

### T007 — Wire orchestrator `onSessionId` → dispatch

**File:** `src/engine/orchestrator/run.ts`, `src/engine/orchestrator/events.ts`

In `runWorkflow` planner callbacks construction, add `onSessionId: (id) => { state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PLANNER_SESSION_ID', sessionId: id }); setTrackedState(state); }`.

Export a helper `updatePlannerSessionId(ctx, id)` from `events.ts` if this gets called from multiple places.

### T008 — Accept `initialSessionId` in agent-sdk planner

**File:** `src/engine/planners/agent-sdk.ts`

Agent SDK exposes session resume via its own API — research the SDK docs, same shape. Pass through `initialSessionId`, forward `session_id` emissions to `onSessionId`.

### T009 — Thread `initialSessionId` through `createPlanner` factory

**File:** `src/engine/runners/factory.ts`

Signature: `createPlanner(config, initialSessionId?: string | null): Planner`. Dispatch by `kind`:
- `cli` + tool=claude-code → pass through.
- `agent-sdk` → pass through.
- other cli tools → ignore (no session resume).
- `api`, `shell`, `agent` → ignore at the factory; shell/agent users who declared `capabilities.supportsSessionResume: true` in config are responsible for handling resume in their wrapper command if they want it.

## Phase 3 — Resume context rebuild

### T010 — Create `src/engine/orchestrator/transcript-rebuild.ts`

Per `plan.md` → "Transcript rebuild in orchestrator". Takes `projectDir, sessionId, persistTranscript`; returns `{ messages, warning? }`. Uses `readMessages` from spec 003.

### T011 — Detect Claude session rejection

**File:** `src/engine/claude-runner.ts`

Inspect stderr / parsed errors for "session not found" / appropriate error code. On detection:
1. Null out internal sessionId.
2. Emit `onSessionExpired(previousId)` on callbacks (new optional callback).
3. Retry invoke without `--session-id`.

Add the new `onSessionExpired` field to `PlannerCallbacks`.

### T012 — Orchestrator handles `onSessionExpired`

**File:** `src/engine/orchestrator/run.ts`

Wire `onSessionExpired: async () => { const ctx = await buildResumeContext(projectDir, sessionId, config.workflow.persistTranscript); plannerContextOverride = ctx; emit(... 'session_expired', ...) }`.

On the next planner call, if `plannerContextOverride` is set, splice it into the prompt per `plan.md` → "Injection into next planner call".

### T013 — Wire transcript rebuild for api-kind planner

**File:** `src/engine/planners/api.ts`

When the planner has `initialSessionId` and the config said `supportsSessionResume: false` (shouldn't happen for known api backends, but possible for shell-api hybrids), ignore `initialSessionId`. For transcript rebuild: api planner already takes a `messages` array — accept a `priorMessages?: Array<{role,content}>` and prepend before the current prompt.

### T014 — Wire transcript rebuild for cli fallback

**File:** `src/engine/planners/base.ts` or `src/engine/planners/cli.ts`

For cli planners that can't natively resume (i.e. have `supportsSessionResume: false`), if the orchestrator passes rebuilt messages, format them as the `<!-- prior conversation -->…<!-- /prior conversation -->` block and prepend to the next prompt.

## Phase 4 — Tests

### T015 — Test session-id capture

Run a fake Claude Code stream emitting `{ session_id: "abc123" }`. Assert `state.plannerSessionId === 'abc123'` after a single call.

### T016 — Test resume with valid id

Mock Claude runner to accept `--session-id abc123` without error. Run resume with `plannerSessionId: 'abc123'` in state. Assert `--session-id abc123` was passed to the subprocess (inspect spawn args).

### T017 — Test resume with expired id

Mock Claude runner to reject `--session-id abc123` with "session not found". Assert: `session_expired` event emitted, transcript rebuild triggered (read messages from session.jsonl fixture), new session opened.

### T018 — Test resume with `supportsSessionResume: false` backend

Run resume where planner is api-kind with `plannerSessionId: 'xyz'` in state. Assert planner is constructed WITHOUT `initialSessionId` threaded through and transcript rebuild is used instead.

### T019 — Full suite

`npm test` → all green.

## Phase 5 — Doc Sync

### T020 — Update `docs/WORKFLOW.md` §1.5 "Resume behaviour"

Confirm the three-step fallback (native → rebuild → artifacts-only) matches the implementation. Add a code-location pointer to `src/engine/orchestrator/transcript-rebuild.ts`.

### T021 — Update `docs/CONCEPTS.md` §"Sessions"

Confirm the "One diptych session may own several planner session ids over its lifetime" sentence is accurate — a new planner sessionId after a rejection means exactly this.

### T022 — Update `docs/ARCHITECTURE.md` "Capability matrix"

No structural change but: add a note in the "No session resume? Rebuild from transcript" fallback description, referencing spec 004 for detail.
