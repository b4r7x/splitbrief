# 003 — Session JSONL Log — Tasks

## Phase 1 — Types + paths

### T001 — Rename `EVENTS_FILE` → `SESSION_LOG_FILE`

**File:** `src/core/paths.ts`

Delete `EVENTS_FILE` constant. Add `SESSION_LOG_FILE = 'session.jsonl'`. Grep for `EVENTS_FILE` and update every read site.

### T002 — Add `SessionLogEntry` discriminated union

**File:** `src/core/types/events.ts`

Add `SessionLogEventEntry`, `SessionLogMessageEntry`, and `SessionLogEntry` union per `plan.md` → "Session log entry shape". Export from `src/core/types/index.ts`.

### T003 — Add `workflow.persistTranscript` to config schema

**File:** `src/core/types/schemas/config.ts`

Extend `WorkflowConfigSchema` with `persistTranscript: z.boolean().default(true)`. No migration code needed (Zod default handles missing field).

Update `docs/CONCEPTS.md` §"Queue & Interjection" / §"Artifacts on disk" if the field is mentioned there (it is). Leave that doc change to T017 for consistency with other doc sync tasks.

## Phase 2 — Writer API

### T004 — Implement `appendEvent` with sessionId + write to `session.jsonl`

**File:** `src/core/state/persistence.ts`

Current `appendEvent(projectDir, event)` — signature change per spec 002 T008 already makes it `(projectDir, sessionId, event)`. Write to `SESSION_LOG_FILE` (not `EVENTS_FILE`). Add `kind: 'event'` to the serialized entry.

### T005 — Implement `appendMessage`

Same file. Per `plan.md` → "Writer API". Gate on `persistTranscript` boolean argument. Write to same file as `appendEvent` (`session.jsonl`).

Add colocated test that sets `persistTranscript=false` and asserts the file remains unchanged after call.

### T006 — Implement chunk buffer helper in planner base

**File:** `src/engine/planners/base.ts`

Introduce a `ChunkBuffer` class or closure that:

- Accepts chunks via `add(text, phase)`.
- Flushes to `appendMessage` when `flush(reason)` is called. Reasons: `'call-complete' | 'phase-boundary' | 'size-limit'`.
- Caps at 16KB; auto-flush with `reason: 'size-limit'` if hit.

Wire into `createPlannerBase`: every `onOutput(text)` passes through the buffer. `invokePlan`/`invokeEscalate` returning triggers `flush('call-complete')`.

### T007 — Apply buffer to implementer base

**File:** `src/engine/implementers/base.ts`

Same pattern if implementers stream output. Some implementer backends (e.g. `agent` kind that writes files) don't stream text — skip buffering there.

## Phase 3 — Plumb user-side message appends

### T008 — Append user prompt at workflow start

**File:** `src/engine/orchestrator/run.ts`

In `initializeWorkflow`, after the `workflow_started` event, call `appendMessage({ role: 'user', text: feature })`.

### T009 — Append clarification answers

**File:** `src/engine/orchestrator/clarifications.ts`

For each collected answer (line 18 area), call `appendMessage({ role: 'user', phase: 'specifying', text: answer })` before writing to `spec.md`.

### T010 — Append approval-gate comments

**File:** `src/engine/orchestrator/approval.ts`

When `result.comment` is non-empty (line 40), append `{ role: 'user', phase: 'reviewing-spec' | 'reviewing-plan', text: result.comment }` before the regenerate call.

## Phase 4 — Reader API

### T011 — Create `src/core/sessions/log-reader.ts`

Per `plan.md` → "Reader API". Use Node `readline` for bounded memory. Export three async iterables: `readSessionLog`, `readMessages`, `readEvents`. Colocate tests using fixture `.jsonl` content.

## Phase 5 — Tests

### T012 — End-to-end test: transcript on

Spawn a headless `runWorkflow` against a fake planner that streams a fixed response. Assert `session.jsonl` contains expected event entries **and** message entries with the planner text.

### T013 — End-to-end test: transcript off

Same fixture, set `persistTranscript: false`. Assert `session.jsonl` contains events but zero `kind: 'message'` lines.

### T014 — Test chunk buffering

Feed a buffer 100 small chunks, verify only one `appendMessage` call fires on flush (via mock spy). Size-limit auto-flush: feed 20KB of content, verify flush fired with `reason: 'size-limit'`.

### T015 — Run full suite

`npm test` — all green.

## Phase 6 — Doc Sync

### T016 — Update `docs/CONCEPTS.md` §"Events & messages"

Confirm the described flow matches code: one file, type-tagged, filter at read, opt-out via `persistTranscript`. Add a reference to `src/core/sessions/log-reader.ts`.

### T017 — Update `docs/CONCEPTS.md` §"Artifacts on disk"

The layout diagram lists `session.jsonl` — confirm it's accurate and the commentary mentions "append-only, type-tagged".

### T018 — Update `docs/WORKFLOW.md` §1.4 Persistence timing

Rows that mention `kind: "event"` / `kind: "message"` should match the implemented writer API (always write events; write messages iff persistTranscript).

### T019 — Update `docs/ARCHITECTURE.md` §"Persistence"

`session.jsonl` row already present — confirm path and lifecycle match code.
