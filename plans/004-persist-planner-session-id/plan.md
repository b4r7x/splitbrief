# 004 — Persist Planner Session ID — Plan

## Data model

### Rename on `WorkflowState`

**File:** `src/core/types/schemas/workflow.ts`

Rename `sessionId: string | null` → `plannerSessionId: string | null`. Bump `CURRENT_STATE_VERSION` from 2 to 3 (migration handled by spec 009).

### Rename on state machine action

**File:** `src/core/state/machine.ts`

`SET_SESSION_ID` → `SET_PLANNER_SESSION_ID`. Update reducer (line 128-129).

## Planner interface

### Construction signature

Backends today get their factory signature like `createClaudeCodePlanner(model?: string)`. Extend to `createClaudeCodePlanner(model?: string, initialSessionId?: string | null)`. Same pattern for any other backend with `supportsSessionResume: true` (today: Claude Code + agent-sdk).

Factories for backends with `supportsSessionResume: false` ignore the argument or don't accept it at all — the caller checks capability before passing.

### Session-id callback

New optional field on the `PlannerCallbacks` interface already present in `src/engine/planners/types.ts`:

```ts
export interface PlannerCallbacks {
  onOutput: (text: string) => void;
  onPhase?: (phase: string) => void;
  onQuestion?: (questions: ClarificationQuestion[]) => void;
  onSessionId?: (sessionId: string) => void;  // NEW
}
```

Claude Code planner, when it receives a `session_id` from the stream (see `src/engine/claude-runner.ts:64-66`), invokes `onSessionId` if provided.

### Orchestrator wiring

`runWorkflow` wraps its planner's callbacks to route `onSessionId` to state dispatch:

```ts
const plannerCallbacks = {
  onOutput: (text) => { /* existing */ },
  onSessionId: (id) => {
    state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PLANNER_SESSION_ID', sessionId: id });
    setTrackedState(state);
  },
  // …
};
```

## Resume flow

### `runWorkflow` init path changes

**File:** `src/engine/orchestrator/run.ts` → `initializeWorkflow`

Before (today, constructs planner fresh):
```ts
const planner = createPlanner(config);
```

After:
```ts
const plannerSeedId = savedState?.plannerSessionId ?? null;
const planner = createPlanner(config, plannerSeedId);
```

The `createPlanner` factory in `src/engine/runners/factory.ts` threads the second argument through to the backend-specific constructor. Backends that don't accept it ignore it (TS typing allows).

### Runtime factory

**File:** `src/engine/runners/factory.ts`

Update `createPlanner(config, initialSessionId?)` — pass `initialSessionId` only to backends whose config kind declares a capability (spec 001's matrix). Typescript union narrowing keeps this safe.

## Expired-session handling

### Detecting expiry in Claude Code runner

**File:** `src/engine/claude-runner.ts`

When invoking `claude --session-id <id> …`, detect the error string Claude emits (research during T008 — likely contains "session not found" or a specific exit code). On detection:

1. Reset `state.sessionId` to null.
2. Retry the same call **without** `--session-id`.
3. Invoke a new callback `onSessionExpired(previousId: string)` so orchestrator can trigger transcript rebuild.

### Transcript rebuild in orchestrator

**New module:** `src/engine/orchestrator/transcript-rebuild.ts`

```ts
export async function buildResumeContext(
  projectDir: string,
  sessionId: string,
  persistTranscript: boolean,
): Promise<{ messages: Array<{role:'user'|'assistant'; content:string}>; warning?: string }> {
  if (!persistTranscript) {
    return { messages: [], warning: 'transcript-unavailable' };
  }
  const messages = [];
  for await (const m of readMessages(projectDir, sessionId)) {
    messages.push({ role: m.role, content: m.text });
  }
  return { messages };
}
```

### Injection into next planner call

For **api-kind backends**: passed as the `messages` array at the start of the chat completion request.

For **cli-kind fallback** (Claude Code after session-expired): prepend a markdown block to the next prompt:

```
<!-- prior conversation -->
[user] Original feature: add email validator
[assistant] I'll research the project structure...
[user] Use JWT with refresh tokens
...
<!-- /prior conversation -->

Now continue from where you left off.
```

## Dependencies

**Depends on:** 001 (capabilities), 002 (sessionId field on `WorkflowContext`), 003 (`readMessages` from log-reader).

**Consumed by:** 005 (abort/resume uses same persistence), 007 (queue mid-phase relies on same session-id capture to inject user turns).

## Risk

- **Session id format differences per backend.** Claude Code uses UUID; hypothetical other backends may use different formats. `plannerSessionId` is typed as `string | null`, opaque. Each backend owns its format.
- **Race between capture and save.** If workflow crashes after the stream returns session-id but before the `dispatch` fires, the session id is lost. Minor. Next run just starts fresh.
- **Claude-specific error string detection.** Hardcoding on an error message string is brittle. Add a fallback heuristic: after N consecutive rejects of the same id, abandon it regardless of error message.

## Success verification

- `npm run typecheck` passes after all signature changes.
- `npm test` passes.
- Manual smoke: run → Ctrl-C twice → inspect `state.json` → resume → planner remembers context.
- Manual smoke: delete `state.plannerSessionId` manually → resume → transcript rebuild triggers, toast appears, run continues.
