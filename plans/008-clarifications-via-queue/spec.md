# 008 — Clarifications via Queue

## Problem

Today, when the planner emits a clarification question (`<!-- Q:{...} -->` marker) and the user answers, the answer is:

1. Appended to `spec.md` under `## Clarifications` (`src/engine/orchestrator/clarifications.ts`).
2. Seen by the planner only on the **next** planner call (regenerate or plan phase), because the current stream is still in flight.

This mirrors a known gap that users feel: "I answered, why doesn't Claude know yet?". With spec 007 introducing the queue and parallel native injection, we can close this gap by routing clarification answers through the same mechanism.

## Goal

Make clarification answers use the spec 007 queue. On capable backends (Claude Code), the answer is dispatched into the live session in parallel so the planner sees it within one model turn. On stateless backends, it goes into the queue for delivery at the next planner call — same as today but now through a unified path.

## User stories

- **As a Claude Code user answering "use JWT" during live `specifying`**, the planner's very next stream segment references JWT. No waiting for regenerate.
- **As an Ollama user answering the same**, the planner's next prompt (regenerate or plan phase) starts with a queue block containing my answer, plus the `spec.md` Clarifications section still reflects it for artifact purposes.
- **As a diptych developer**, clarification answers are handled by the same queue-drain path as arbitrary user interjections — one code path, one test surface.

## Functional requirements

**FR-001.** `collectAndPersistClarifications` in `src/engine/orchestrator/clarifications.ts` continues to write answers to `spec.md` **and** additionally calls the queue enqueue path for each answer.

**FR-002.** Enqueued clarification messages have a new `origin: 'clarification'` field on `QueuedMessage` to distinguish them from user-initiated interjections (useful for UI badges and audit). Update `QueuedMessageSchema` from spec 007.

**FR-003.** Native injection for clarification answers follows spec 007 (silent-degrade on failure). The native injected message is formatted to reference the question, e.g.:

```
[clarification answer]
Q: <question text>
A: <user answer>
[/clarification answer]
```

so the planner understands the pairing.

**FR-004.** The drain-at-safe-point path also uses this formatted block for clarification entries (not the generic `[user also says]` wrapper).

**FR-005.** `clarification_answered` event (new or existing — check `src/core/types/events.ts`) emits with the question id + answer for session.jsonl trace.

**FR-006.** Phase-guard: clarification answers can only originate during `researching` or `specifying` (the two phases where planners emit Q markers). If a clarification arrives outside those phases, log a warning and drop — never enqueue.

**FR-007.** Backwards compatible: the `spec.md` Clarifications section continues to be written as today. This spec does not change the artifact layer.

## Success criteria

- Running a Claude Code workflow, answering a clarification mid-`specifying`: Claude's next token stream references the answer within ~1s.
- Running an Ollama workflow, answering a clarification: queue has the entry, drains at next phase boundary, `spec.md` has the Clarifications entry.
- `session.jsonl` shows the expected chain: `clarification_asked` → `clarification_answered` → `message_queued` → `message_injected_native` (Claude only) → `queue_drained` (after phase boundary).
- All tests pass. Updated tests for `clarifications.ts` reflect new queue-routing.

## Non-goals

- Changing what a clarification question looks like (still the `<!-- Q:{JSON} -->` marker).
- Changing the 5-question-per-run cap (`MAX_CLARIFICATION_QUESTIONS` in `planning.ts`).
- Allowing clarification-style injections in phases other than researching/specifying.
- Auto-re-issuing clarifications if a user's answer was drained too late (out of scope).
