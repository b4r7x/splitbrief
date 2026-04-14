# 007 — Queue Mid-Phase Injection — Tasks

## Phase 1 — State model

### T001 — Add `QueuedMessage` schema + state field

**File:** `src/core/types/schemas/workflow.ts`

Define `QueuedMessageSchema` and add `messageQueue: z.array(QueuedMessageSchema).default([])` to `WorkflowStateSchema`. Update `createInitialState` (`src/core/state/machine.ts`) to initialise `messageQueue: []`.

### T002 — Add four state-machine actions

**File:** `src/core/state/machine.ts`

Add `ENQUEUE_USER_MSG`, `MARK_DELIVERED_NATIVE`, `DRAIN_QUEUE`, `CLEAR_QUEUE` per `plan.md`. Implement reducers.

### T003 — Add three event types

**File:** `src/core/types/events.ts`

`message_queued`, `message_injected_native`, `queue_drained`, `queue_cleared` (from `/queue clear` command).

### T004 — Event card renderers

**File:** `src/components/event-cards/index.tsx`

Minimal cards for each new event.

## Phase 2 — Enqueue path

### T005 — `isImplementerPhase(phase)` helper

**File:** `src/core/phases.ts`

Boolean function. Used to gate input mode.

### T006 — Phase-aware text submit in TUI

**File:** `src/components/input-bar/input-bar.tsx` (or consumer hook)

On Enter-with-text, route based on phase:
- Implementer phase → error feedback, do not enqueue.
- Approval gate or awaiting-continue → existing handlers.
- Live planner phase → enqueue.

### T007 — `enqueueUserMessage` function

**File:** new in `src/hooks/use-workflow-review-input.ts` or a sibling hook

Per `plan.md` → "Enqueue path". Dispatches `ENQUEUE_USER_MSG`, emits event, appends to `session.jsonl`, optionally calls `dispatchNativeInjection`.

### T008 — Queue size cap

Before enqueueing, check `state.messageQueue.filter(m => !m.drainedAt).length` against a constant `MAX_QUEUE_SIZE = 50`. If at cap, set feedback error "Queue full (50 pending). Wait for drain or use /queue clear." and return without enqueueing.

## Phase 3 — Native injection

### T009 — Extend `Planner` interface with `injectUserTurn`

**File:** `src/engine/planners/types.ts`

Optional method:

```ts
injectUserTurn?(text: string, plannerSessionId: string, projectDir: string, sessionId: string): Promise<void>;
```

### T010 — Implement `injectUserTurn` in Claude Code planner

**File:** `src/engine/planners/claude-code.ts`

Fire-and-forget `claude --session-id <id> -p <text>`. Do not await output. Use `spawn` in detached mode. Log completion via `onOutput` or skip.

### T011 — Implement `injectUserTurn` in agent-sdk planner

**File:** `src/engine/planners/agent-sdk.ts`

Use SDK's equivalent inject method. Research SDK surface during implementation.

### T012 — `dispatchNativeInjection` module

**File:** `src/engine/orchestrator/native-injection.ts`

Per `plan.md`. Silent-failure contract: errors are logged to stderr, not surfaced to user (we fall back to drain-on-boundary).

## Phase 4 — Drain path

### T013 — `drainQueue` helper

**File:** `src/engine/orchestrator/queue-drain.ts`

Per `plan.md`. Returns `{ prepend, drained }`.

### T014 — Drain at end of planner call

**File:** `src/engine/planners/base.ts`

After each `invokePlan`/`invokeEscalate`/`regenerate` returns, BEFORE building the next prompt, call `drainQueue(state)` via the orchestrator and use the `prepend` result.

### T015 — Drain at phase boundaries

**File:** `src/engine/orchestrator/run.ts` (`transitionAndSave` or equivalent)

After any `transitionAndSave` that changes the phase, call `drainQueue`. Most phase transitions precede a fresh planner call; the prepend is attached to that call.

### T016 — Unified "prior context" channel

**Files:** `src/engine/planners/*.ts`

Consolidate "transcript rebuild" (spec 004) + "queue prepend" (this spec) into one `priorContext?: string` argument on every planner method. Each planner prepends `priorContext` to its prompt. Simpler than two separate concepts.

## Phase 5 — UI surface

### T017 — Queue indicator in footer

**File:** `src/components/workflow/cost-footer.tsx`

When `messageQueue.filter(m => !m.drainedAt).length > 0`, render `queue: N` segment.

### T018 — `/queue show` slash command

Registry entry + handler that emits visible cards for each queued message.

### T019 — `/queue clear` slash command

Registry entry + handler that dispatches `CLEAR_QUEUE` and emits `queue_cleared`.

## Phase 6 — Tests

### T020 — Enqueue test

Simulate Enter-with-text during `specifying`. Assert: state's messageQueue has one entry, event emitted, session.jsonl message appended.

### T021 — Implementer-phase block test

During `implementing`, submit text. Assert: queue unchanged, feedback error set.

### T022 — Native injection test (Claude Code mock)

Spawn mock claude subprocess. Enqueue message. Assert: child spawned with `--session-id` + `-p <text>`; no stream awaited; `MARK_DELIVERED_NATIVE` dispatched.

### T023 — Drain-on-boundary test

Pre-populate queue with 2 messages. Run fake planner invoke. Assert: planner received prompt starting with `[user also says during specifying]` block containing both messages.

### T024 — Queue persistence test

Pre-populate queue. Save state. Reload state via `loadState`. Assert: queue restored intact.

### T025 — Queue size cap test

Enqueue 50 messages (none drained). Attempt 51st — assert feedback error, state unchanged.

### T026 — Full suite

`npm test` → green.

## Phase 7 — Doc Sync

### T027 — Update `docs/CONCEPTS.md` §"Queue & Interjection"

Confirm the description matches implementation (enqueue semantics, native injection, drain timing, size cap). Link to `src/hooks/use-workflow-review-input.ts`, `src/engine/orchestrator/queue-drain.ts`.

### T028 — Update `docs/WORKFLOW.md` §1.6 and §1.7

§1.6 "The interaction model" — confirm "Queue message" row.
§1.7 "Mid-phase user interjection — full flow" — confirm all 4 steps are implemented.

### T029 — Update `docs/ARCHITECTURE.md` data flow

Step 9 mentions queue — confirm matches. Reference `workflowStore.messageQueue` field.
