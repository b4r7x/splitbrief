# 008 — Clarifications via Queue — Plan

## Data model

### Extend `QueuedMessage`

**File:** `src/core/types/schemas/workflow.ts`

Add optional `origin?: 'user-input' | 'clarification'` to `QueuedMessageSchema`. Default `'user-input'` if missing. No migration needed — Zod handles optional.

Clarification-origin messages additionally carry:
- `question: string` — the original question text
- `questionId?: string` — if the planner's Q marker had an id

### Event type

**File:** `src/core/types/events.ts`

Confirm `clarification_answered` exists; if not, add with `{ questionId, answer }` payload. Already likely present from earlier work — grep to verify.

## Flow changes

### `collectAndPersistClarifications` — updated

**File:** `src/engine/orchestrator/clarifications.ts`

Current behaviour: for each answered question, push to an array, then write the whole block to `spec.md`.

New behaviour: for each answered question, in addition to the existing persist step, call:

```ts
enqueueUserMessage({
  text: answer,
  origin: 'clarification',
  question: question.text,
  questionId: question.id,
});
```

`enqueueUserMessage` is the same helper introduced by spec 007. It handles native injection and session.jsonl appending. We add a discriminator so the drain format can be specialised.

### Drain formatting for clarifications

**File:** `src/engine/orchestrator/queue-drain.ts` (from spec 007)

Extend the block builder to switch on `origin`:

```ts
function formatMessage(m: QueuedMessage): string {
  if (m.origin === 'clarification') {
    return `[clarification answer during ${m.phase}]\nQ: ${m.question}\nA: ${m.text}\n[/clarification answer]`;
  }
  return `[user also says during ${m.phase}]\n${m.text}\n[/user also says]`;
}
```

### Native injection text

**File:** `src/engine/orchestrator/native-injection.ts`

For clarification-origin messages, send the same `[clarification answer]` block to the native session rather than raw text. Lets Claude correctly associate answer to question.

## Phase guard

**File:** `src/engine/orchestrator/clarifications.ts`

Guard at function entry:

```ts
if (state.phase !== 'researching' && state.phase !== 'specifying') {
  warnStderr(`Clarification answers arrived in phase ${state.phase} — dropping.`);
  return;
}
```

## Dependencies

**Depends on:** 007 (queue + native injection infra).

**Consumed by:** nothing further.

## Risk

- **Double-delivery.** If clarifications currently write to `spec.md` and now ALSO enqueue, Claude sees the content twice — once via the spec.md re-read on next regenerate, once via the queue. Mitigation: planner deduplicates semantically (it's the same content). This is a soft risk. If it proves noisy, we can drop the spec.md append for capable backends — but that's a follow-up.
- **Clarification during stateless run.** `enqueueUserMessage` will still work (spec 007 supports stateless via drain). No new risk.

## Success verification

- Manual: on Claude Code, answer a clarification — verify (a) `spec.md` has the entry, (b) `session.jsonl` has `message_queued origin:clarification` + `message_injected_native`, (c) Claude's next stream acknowledges the answer.
- Manual: on api-kind, answer a clarification — verify queue drain on next phase boundary; planner prompt includes the `[clarification answer]` block.
- Tests: covered in tasks.md.
