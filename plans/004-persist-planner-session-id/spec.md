# 004 — Persist Planner Session ID

## Problem

`WorkflowState` has a `sessionId: string | null` field (schema in `src/core/types/schemas/workflow.ts`) and the state machine defines a `SET_SESSION_ID` action (`src/core/state/machine.ts:128-129`). Both exist but are **never dispatched**. Claude Code's `createClaudeCodePlanner` holds the backend session handle in a closure variable (`let currentSessionId: string | null = null` at `src/engine/planners/claude-code.ts:10`), so each fresh planner construction starts a fresh Claude session.

Result: on `diptych resume`, Claude Code opens a brand-new session with no memory of the prior conversation. Users lose the planner's research context, reasoning, and any off-artifact detail. See `docs/WORKFLOW.md` §1.5 for the target behaviour.

## Goal

Capture the planner's native session handle during live runs and persist it in `state.json`. On resume, pass the persisted handle back to the planner so the conversation continues in the same native session. When the backend rejects the handle (session expired), fall back to rebuilding context from `session.jsonl` messages (produced by spec 003) and proceeding with a fresh session.

## User stories

- **As a Claude Code user who Ctrl-Cs mid-run**, I resume hours later and Claude remembers every clarification I gave — no re-answering.
- **As an Ollama/api-kind user**, resume rebuilds my conversation from the disk transcript and the planner picks up with full context even though the backend was stateless.
- **As a user of a shell planner that declared `supportsSessionResume: true` in config**, resume attempts to reuse the handle; on rejection, a clear toast explains fallback and the run continues.

## Functional requirements

**FR-001.** Rename `sessionId` field on `WorkflowState` to `plannerSessionId: string | null` to disambiguate from diptych-session-id (which is now the folder name per spec 002). Update schema, state machine action name → `SET_PLANNER_SESSION_ID`.

**FR-002.** `Planner` interface (updated by spec 001) gains an optional second argument to construction factories: `initialSessionId?: string | null`. Backends with `capabilities.supportsSessionResume === true` must accept it; backends without may ignore it.

**FR-003.** Inside Claude Code planner, the factory accepts `initialSessionId` and seeds the closure `currentSessionId` with it. On each `invokePlan` call, after the stream returns a session id, dispatch `SET_PLANNER_SESSION_ID` via a callback that the orchestrator wires in.

**FR-004.** Orchestrator (`runWorkflow`, `src/engine/orchestrator/run.ts`) wires a `onSessionId: (id) => dispatch({ type: 'SET_PLANNER_SESSION_ID', sessionId: id })` callback into planner construction. Every state change triggers the usual `saveState` — so `state.plannerSessionId` ends up persisted in `sessions/<id>/state.json`.

**FR-005.** On resume (`src/cli/commands/resume.ts` → `runWorkflow` with `savedState`):
  1. If `savedState.plannerSessionId` is set **and** `planner.capabilities.supportsSessionResume`, construct planner with `initialSessionId: savedState.plannerSessionId`.
  2. Otherwise, construct planner fresh (no initial id).

**FR-006.** When the backend rejects a session id (Claude Code returns a specific error, e.g. `session not found`), the planner detects this in its invoke implementation and:
  1. Emits a `session_expired` event via a callback.
  2. Opens a fresh session and continues.
  3. The orchestrator, on receiving `session_expired`, reads `session.jsonl` via `readMessages(projectDir, sessionId)`, filters messages up to the abort/resume point, and injects them as context for the next planner prompt.

**FR-007.** Transcript rebuild format: for api-kind backends, build a `messages: [{role: 'user'|'assistant', content: text}]` array passed to the OpenAI-compatible chat completion API. For cli backends (Claude Code fallback, codex, etc.), prepend a `<!-- prior conversation -->\n<role: user>\n<content>\n<role: assistant>\n<content>\n...\n<!-- /prior conversation -->` block to the fresh prompt.

**FR-008.** If `persistTranscript` is `false` (spec 003 gate) and the native session also fails, the user is warned: `Previous planner conversation expired and no transcript was persisted. Continuing with spec.md/plan.md/tasks.md only — the planner may regenerate differently.` Then proceed with just the artifacts as context.

**FR-009.** Capability `supportsSessionResume` is read, not written, by this spec — backend values already set by spec 001. Orchestrator does not attempt resume on backends that declare `false`.

## Success criteria

- `grep -rn "SET_SESSION_ID\\b" src/` returns zero (old name gone).
- `grep -rn "plannerSessionId\\b" src/` returns hits in schema, state machine, orchestrator, planners.
- Manual smoke: run a workflow to `reviewing-spec`, Ctrl-C twice, `cat .diptych/sessions/<id>/state.json | jq .plannerSessionId` shows a UUID-like string.
- Manual smoke: after the above, `diptych resume` continues in the same Claude session — test with a clarification like "what was the last thing I told you?".
- All tests pass. New tests: session-id capture, resume with valid id, resume with expired id, resume with `supportsSessionResume: false` backend.

## Non-goals

- Persisting implementer session handles (implementers are per-task atomic, no session to preserve).
- Multi-session forking or rewind (deferred to `docs/FUTURE.md`).
- Detecting session expiry proactively before a call fires — we let the backend tell us by rejecting.
- Explicit user command to "reset session" / start a new planner session mid-run. Out of scope.
