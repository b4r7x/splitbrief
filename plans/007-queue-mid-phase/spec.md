# 007 — Queue Mid-Phase Injection

## Problem

Today, a user watching the planner stream research or write a spec has no way to leave a note until the next approval gate. Any mid-phase thought has to wait. The only alternative is to abort (spec 005), which costs the current turn entirely.

We want a non-destructive mid-phase channel: user types text + Enter; message is added to a queue; current planner call keeps running. Backends with native session support (Claude Code, agent-sdk) get the message injected into the live session in parallel. All backends pick up queued messages at the next safe-point (phase boundary or call completion).

See `docs/CONCEPTS.md` §"Queue & Interjection" for the target design.

## Goal

Introduce `workflowStore.messageQueue` as a workflow-scoped buffer. TUI writes to it on Enter-with-text during live phases. Orchestrator drains it at safe-points, folding queued messages into the next planner prompt. Backends with `capabilities.supportsMidStreamInjection` additionally receive a parallel dispatch of each queued message into the live native session.

## User stories

- **As a user watching Claude research the codebase who forgets to mention PostgreSQL 15**, I type "btw, PostgreSQL 15" and press Enter. Claude's next token stream picks that up within seconds.
- **As a user on Ollama (stateless)**, same input — queued silently, delivered in the next planner prompt at the next phase boundary.
- **As a user mid-implementation**, the queue is unavailable (planner-only per design) and the TUI shows a hint explaining why.

## Functional requirements

**FR-001.** Add `messageQueue: QueuedMessage[]` to `workflowStore` state.

```ts
type QueuedMessage = {
  id: string;           // random, for dedup/trace
  text: string;
  queuedAt: string;     // ISO timestamp
  phase: Phase;         // phase when queued
  deliveredViaNative: boolean;  // true after parallel dispatch succeeds
  drainedAt?: string;   // ISO timestamp when queue drained into next prompt
};
```

**FR-002.** TUI input behaviour during live **planner** phases (`researching | specifying | planning | reviewing-* | final-review`):
- Text input is enabled.
- Enter with non-empty text → enqueue + emit `message_queued` event + append `kind: 'message', role: 'user'` to `session.jsonl`.
- Enter on empty input → no-op (or navigate command history — not in scope).
- Abort-aware: during awaiting-continue (spec 005), text input still works but follows continuation flow (not queue).

**FR-003.** TUI input behaviour during **implementer** phases (`implementing | validating-task | escalating`):
- Text input is disabled or shows a hint: `Input disabled during task implementation. Press Ctrl-C to abort, or /redo-task <id> after the task finishes.`
- Reason: small implementer models lose coherence with mid-task injection. Design decision, `docs/WORKFLOW.md` §1.6.

**FR-004.** Parallel native-session injection (capability-gated):
- For backends with `capabilities.supportsMidStreamInjection: true` (today: cli claude-code, agent-sdk, opt-in shell/agent):
  - On `ENQUEUE_USER_MSG`, dispatch a **separate** backend call with the queued text and the native session id (from state.plannerSessionId, spec 004).
  - This call is fire-and-forget: we do not wait for its output. Claude's next stream response naturally incorporates the message.
  - On failure (network error, session rejected), silently degrade — the message still lands in the queue for safe-point delivery.
  - Mark `deliveredViaNative: true` on success.

**FR-005.** Safe-point draining. At every phase boundary AND at the end of each planner call (`invokePlan` / `invokeEscalate` / `regenerate` returns):
  1. Check `workflowStore.messageQueue` for entries where `drainedAt` is unset.
  2. If any found, construct a `[user also says: <text>]` block per message.
  3. Prepend the block(s) to the next planner prompt.
  4. Dispatch `DRAIN_QUEUE` (marks all entries as `drainedAt: <now>`).

**FR-006.** Queue prompt format:
```
[user also says during phase <phase>]
<text>
[/user also says]
```
Multiple queued messages are listed in order of `queuedAt`. Prepended before the normal prompt. Planner is instructed (via system prompt addition) to treat these as equally authoritative to the original feature prompt.

**FR-007.** Queue state persists across resume. `messageQueue` is not part of `workflowStore.state` today — move it to `state.json` persisted state, so Ctrl-C Ctrl-C followed by resume preserves unpicked queued messages.

Decision: merge `messageQueue` into `WorkflowState`.

**FR-008.** Queue visible in UI:
- Small indicator in the footer/status bar: `queue: 2 messages` when non-empty.
- Command palette entry `/queue show` that prints queued messages to the event flow.
- Command `/queue clear` removes unpicked messages (with a confirm toast).

**FR-009.** Events logged to `session.jsonl`:
- `message_queued` (event kind): when enqueued.
- `message_injected_native` (event kind): when parallel native dispatch succeeds.
- `queue_drained` (event kind): when DRAIN_QUEUE fires, including count.
- Also a `message` kind with `role: 'user'` for the text itself (so transcript replay reconstructs it).

## Success criteria

- Typing a message during live `researching` phase enqueues it (visible in status footer) without aborting the stream.
- On Claude Code, the message is injected into the live session within ~1s of Enter.
- On api-kind, the message lands in the next planner prompt at the next phase boundary.
- Queued messages survive resume if process was killed before drain.
- During `implementing`, input is disabled with a hint message.
- All tests pass. New tests cover enqueue, drain, parallel injection, persistence.

## Non-goals

- Out-of-order drain (e.g. drain only most recent message). Queue is FIFO.
- User editing a queued message after enqueue. Once queued, immutable.
- Implementer-phase queueing (design rejected).
- Full mid-stream abort-and-inject (that is spec 005's abort flow, which is distinct).
- Queue sharing across sessions.
