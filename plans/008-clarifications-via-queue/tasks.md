# 008 — Clarifications via Queue — Tasks

## Phase 1 — Data model

### T001 — Extend `QueuedMessage` with `origin` + clarification fields

**File:** `src/core/types/schemas/workflow.ts`

Add optional `origin: z.enum(['user-input', 'clarification']).optional()`, `question: z.string().optional()`, `questionId: z.string().optional()`. Update TypeScript type accordingly.

### T002 — Confirm `clarification_answered` event type exists

**File:** `src/core/types/events.ts`

Grep for `clarification_answered`. If absent, add with payload `{ questionId?: string; answer: string }`. If present, update payload if needed.

## Phase 2 — Flow integration

### T003 — Enqueue on clarification answer

**File:** `src/engine/orchestrator/clarifications.ts`

Inside `collectAndPersistClarifications`, for each answered question, after appending to the in-memory list (but before the final `writeSpecFile`), call:

```ts
enqueueUserMessage({
  text: answer,
  origin: 'clarification',
  question: question.text,
  questionId: question.id,
});
```

(`enqueueUserMessage` from spec 007 — import from shared hook or extract into `src/engine/orchestrator/enqueue.ts` for engine-side reuse.)

### T004 — Phase guard in clarifications module

**File:** `src/engine/orchestrator/clarifications.ts`

Guard at function entry: if phase is not `researching | specifying`, warn and return. See plan.md.

### T005 — Extend drain formatter

**File:** `src/engine/orchestrator/queue-drain.ts`

Add `formatMessage(m)` helper per plan.md. Replace the inline template string currently in `drainQueue` with a call to `formatMessage`.

### T006 — Extend native injection text

**File:** `src/engine/orchestrator/native-injection.ts`

Before calling `planner.injectUserTurn`, if `message.origin === 'clarification'`, wrap the text in the `[clarification answer]` block.

## Phase 3 — Tests

### T007 — Enqueue on clarification (Claude Code mock)

Setup: fake planner emits a Q marker, test provides an answer. Assert:
- `spec.md` updated with Clarifications section (existing behaviour preserved).
- `workflowStore.state.messageQueue` has an entry with `origin: 'clarification'` + `question` + `questionId`.
- Native injection called with `[clarification answer] Q: ... A: ... [/clarification answer]` text.

### T008 — Enqueue on clarification (api-kind)

Same setup with api-kind planner (no `supportsMidStreamInjection`). Assert:
- spec.md updated.
- queue has the entry.
- No native injection attempted (capability gate works).
- On next phase boundary, drainQueue produces the `[clarification answer]` block.

### T009 — Phase-guard test

Attempt to call `collectAndPersistClarifications` with `state.phase = 'planning'`. Assert warning logged, no enqueue, spec.md unchanged.

### T010 — Full suite

`npm test`.

## Phase 4 — Doc Sync

### T011 — Update `docs/CONCEPTS.md` §"Clarifying questions"

Add a paragraph: "Since spec 008, clarification answers also route through the same queue as user-initiated interjections (see §Queue & Interjection). On backends with `supportsMidStreamInjection`, the answer reaches the live session immediately; on stateless backends it is drained at the next phase boundary. The `spec.md` Clarifications section is still written as before."

### T012 — Update `docs/WORKFLOW.md` §1.7

Confirm the sentence "Clarification answers go through the same queue" accurately reflects the implementation. Add a link to `src/engine/orchestrator/clarifications.ts` + `queue-drain.ts`.

### T013 — Update `docs/CONCEPTS.md` §"Queue & Interjection"

Mention the `origin: 'clarification'` discriminator and the different formatting of clarification vs user-input messages in the drain block.
