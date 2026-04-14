# 003 — Session JSONL Log

## Problem

Today the orchestrator writes `events.jsonl` into the session folder containing typed event records. Planner text content is ALSO captured by the TUI into `workflowStore`, but never persisted as part of the session log — it lives only in memory until the artifacts (`spec.md`, `plan.md`, `tasks.md`) are written.

Consequences:
1. No transcript survives a run. If the user asks "what exactly did the planner say during research?", we cannot answer after the workflow ends.
2. Resume cannot rebuild planner conversational context from disk — the only thing on disk is final artifacts (curated) plus operational events (metadata).
3. `events.jsonl` name is misleading once we add message content — it would conflate two concerns in one file with an ambiguous name.

See `docs/CONCEPTS.md` §"Events & messages" for the target design and `docs/WORKFLOW.md` §1.4 for the target persistence timing.

## Goal

Replace `events.jsonl` with a single `session.jsonl` file per session holding **both** operational events and (optionally) planner/user conversation content. Each line is type-tagged via a `kind: "event" | "message"` discriminator. Events are always persisted. Messages are persisted iff `workflow.persistTranscript` is `true` (default).

## User stories

- **As a user debugging a completed run**, I can `cat .diptych/sessions/<id>/session.jsonl | jq 'select(.kind=="message")'` and see the exact conversation.
- **As a privacy-concerned user**, I set `workflow.persistTranscript: false` and know that `session.jsonl` only contains event metadata (never planner text).
- **As a developer extending diptych with a new event type**, I add a type to `TuiEvent` union and it starts appearing in `session.jsonl` automatically with no additional write path.

## Functional requirements

**FR-001.** Rename `EVENTS_FILE` constant (currently `events.jsonl`) to `SESSION_LOG_FILE = 'session.jsonl'` in `src/core/paths.ts`.

**FR-002.** Every line in `session.jsonl` is valid JSON with a required top-level shape:

```ts
type SessionLogEntry =
  | { ts: string; kind: 'event'; type: string; [key: string]: unknown }
  | { ts: string; kind: 'message'; role: 'user' | 'assistant'; phase?: string; text: string; interrupted?: boolean; queuedAt?: string; drainedAt?: string; [key: string]: unknown };
```

`ts` is ISO-8601 timestamp (ms precision). `kind` is required. Event-kind entries preserve today's `TuiEvent` shape with the addition of `ts` and `kind`.

**FR-003.** `src/core/state/persistence.ts` exposes:

- `appendEvent(projectDir, sessionId, event)` — writes `{ kind: 'event', ts, ...event }`. Always writes.
- `appendMessage(projectDir, sessionId, message)` — writes `{ kind: 'message', ts, ...message }`. Checks `workflow.persistTranscript` config; when `false`, does nothing.

**FR-004.** Config gains `workflow.persistTranscript: boolean` with default `true`. Schema in `src/core/types/schemas/config.ts`. Migration from v2 configs without this field: populate with `true`.

**FR-005.** The planner streaming pipeline (`src/engine/planners/base.ts` wraps `onOutput`) emits a `message` entry per chunk, or batches chunks — see plan.md for batching strategy. Implementer output does the same.

**FR-006.** User-initiated content flows to `session.jsonl` as `kind: "message", role: "user"`:
  - Original feature prompt (at workflow start)
  - Clarification answers
  - Approval gate comments
  - Queue messages (full mechanism lands in spec 007; this spec plumbs the message append for them)

**FR-007.** The old `EVENTS_FILE` path / symbol name is removed entirely. `events.jsonl` on disk from previous code paths is ignored — no read-back of the old filename. Migration is handled in spec 009.

**FR-008.** A reader utility `src/core/sessions/log-reader.ts` exposes:

```ts
function readSessionLog(projectDir, sessionId): AsyncIterable<SessionLogEntry>;
function readMessages(projectDir, sessionId): AsyncIterable<SessionLogMessageEntry>;
function readEvents(projectDir, sessionId): AsyncIterable<SessionLogEventEntry>;
```

Used by resume transcript rebuild (spec 004) and potentially future session browser UI.

## Success criteria

- `grep -rn "events\\.jsonl\\|EVENTS_FILE" src/` returns zero matches outside migration code in 009.
- Every existing write path that today calls `appendEvent` still works and lands in `session.jsonl`.
- Planner streaming chunks appear in `session.jsonl` as `kind: "message"` entries during a run.
- Setting `workflow.persistTranscript: false` in config produces `session.jsonl` with only `kind: "event"` lines, never `kind: "message"` lines.
- All existing tests pass after path/symbol rename; new tests for message append + persistTranscript behaviour added.
- `docs/CONCEPTS.md` §"Events & messages" and `docs/WORKFLOW.md` §1.4 match the implementation.

## Non-goals

- Timestamp-based merge reads across multiple files (there is only one file per session now).
- Compression or rotation of `session.jsonl`.
- Structured summarisation of long transcripts — deferred to `docs/FUTURE.md`.
- Implementing the queue mechanism that uses message append (spec 007 does that).
- Resume flow that reads the transcript (spec 004 does that).

## Non-FR notes

Chunk granularity: planner text arrives as many small chunks (stream-json). Writing one JSONL line per chunk would bloat the file. See plan.md for the batching/flushing strategy (accumulate per "phase chunk" = end of a logical planner turn).
