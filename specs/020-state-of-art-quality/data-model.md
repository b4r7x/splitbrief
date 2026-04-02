# Data Model: State-of-the-Art Code Quality Overhaul

**Date**: 2026-04-02  
**Feature**: 020-state-of-art-quality

## Entity Changes

This is a refactoring feature. No new persistent data entities are introduced. Changes are limited to in-memory type definitions and React state structures.

### Modified Entities

#### PlannerTokenUsage (new named type)

Replaces 15+ inline `{ inputTokens: number; outputTokens: number }` declarations.

- **inputTokens**: Number of tokens sent to the planner model
- **outputTokens**: Number of tokens received from the planner model
- **Nullable**: Yes — `PlannerTokenUsage | null` when usage data is unavailable

**Used by**: All planner backends (types.ts, base.ts, claude-code.ts, codex.ts, opencode.ts, aider.ts, agent-sdk.ts, shell.ts), orchestrator tokens module, output-parsers, claude-stream.

#### ImplementerTokenUsage (new named type)

Replaces 5+ inline `{ promptTokens: number; completionTokens: number }` declarations.

- **promptTokens**: Number of tokens in the implementer prompt (OpenAI convention)
- **completionTokens**: Number of tokens in the implementer response (OpenAI convention)
- **Nullable**: Yes — `ImplementerTokenUsage | null`

**Used by**: Implementer routing, shell implementer, openai-stream, orchestrator tokens module.

#### WorkflowHookState (new reducer state)

Replaces 7 separate `useState` calls in `useWorkflow`.

- **events**: Array of TuiEvent objects (max 10,000)
- **phase**: Current workflow phase string
- **currentTask**: Index of current task (0-based)
- **totalTasks**: Total number of tasks
- **localCount**: Number of tasks completed locally
- **escalatedCount**: Number of tasks escalated to planner
- **reviewFilePath**: Path to current review file (nullable)

**State transitions**: Managed via `useReducer` with action types: `ADD_EVENT`, `SET_PHASE`, `SET_PROGRESS`, `SET_REVIEW_FILE`, `RESET`.

#### AppContext (new React Context value)

- **config**: Full Config object
- **theme**: Resolved Theme object (from config.theme mode)
- **commands**: Array of SlashCommand definitions
- **errorMessage**: Current error message (nullable)
- **onClearError**: Callback to clear error message

**Provider location**: `src/app.tsx`  
**Consumers**: All screens and UI components that currently receive these via props.

### Removed Entities

- `acquireLock` / `releaseLock` functions from `src/utils/fs.ts`
- 25+ dead type exports (listed in research.md Section 8)
- Redundant `screen` state from `useRouter` hook

### Unchanged Entities

- All persistent state (`.tiny-spec/state.json`, `events.jsonl`, session files)
- Config file format (`.tiny-spec/config.yaml`)
- All engine interfaces (`PlannerBackend`, `OrchestratorCallbacks`, `TuiEvent`)
- CLI command interface
