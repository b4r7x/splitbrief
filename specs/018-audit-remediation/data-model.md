# Data Model: Audit Remediation

**Type**: Internal refactoring — no new runtime data entities. This document describes new TypeScript option/context types introduced to replace excessive positional parameters, and module restructuring.

## New Option Types (US4)

These types replace functions with >3 positional parameters. Each groups related parameters into a single options object.

### RunTaskLoopOptions

Replaces `runTaskLoop`'s 9 parameters (minus 2 unused: `feature`, `startTime`).

- `projectDir`: string — working directory
- `config`: Config — full configuration
- `callbacks`: OrchestratorCallbacks — event/approval callbacks
- `context`: ProjectContext — project file context
- `initialState`: WorkflowState — starting state
- `setTrackedState`: function — state tracking callback for shutdown handler
- `setCurrentTask`: function — current task tracking callback

### ValidateCommitOptions

Replaces `validateCommitAndAdvance`'s 10 parameters.

- `task`: Task — current task
- `projectDir`: string — working directory
- `config`: Config — full configuration
- `state`: WorkflowState — current state
- `callbacks`: OrchestratorCallbacks — event callbacks
- `method`: 'local' | 'escalated' — implementation method
- `context`: ProjectContext — project file context
- `attempt`: number — retry attempt count
- `taskBreakdowns`: TaskTokenUsage[] — token tracking array
- `tokensBefore`: TokenUsage — snapshot before implementation

### StreamCompletionOptions

Replaces `streamCompletion`'s 7 parameters (grouping the 4 non-core params).

- `temperature`: number — model temperature
- `onProgress`: function — chunk callback
- `config`: Config — for timeout
- `maxTokens`: number (optional) — output cap

Core params stay positional: `client`, `model`, `messages`.

### PlanningPhaseOptions

Replaces `runPlanningPhase`'s 7 parameters.

- `feature`: string — feature description
- `projectDir`: string — working directory
- `config`: Config — full configuration
- `callbacks`: OrchestratorCallbacks — event/approval callbacks
- `planner`: PlannerBackend — planner instance
- `state`: WorkflowState — current state
- `selectedSkills`: SkillMeta[] (optional) — selected skills

### Additional Options Types (smaller, may use inline types)

- `SpawnAgentOptions` — for `spawnAgent` (7 params): command, args, prompt, projectDir, timeout, useStdin, onProgress
- `RunOpenAIOptions` — for `runOpenAIImplementer` (7 params): task, projectDir, config, prompt, temperature, onProgress, onEvent
- `RetryTaskOptions` — for `retryTask` (8 params): task, projectDir, config, context, error, attempt, onProgress, onEvent

## Module Restructuring (US2)

### New Files

**`src/engine/orchestrator/helpers.ts`**
- Receives: `refreshCurrentCode(task, projectDir)` from `task-loop.ts`
- Purpose: Break circular import between `task-runner.ts` and `task-loop.ts`
- Exports: `refreshCurrentCode`

**`src/engine/planners/spawn.ts`**
- Receives: `spawnWithStdin()`, related spawn types from `base.ts`
- Purpose: Isolate subprocess lifecycle management from planner factory logic
- Exports: `spawnWithStdin`, `InvokeResult` type

**`src/engine/planners/context.ts`**
- Receives: `buildProjectContextMarkdown()`, `listDir()` from `base.ts`
- Purpose: Isolate project context gathering from planner factory logic
- Exports: `buildProjectContextMarkdown`

### Modified Export Surfaces

**`src/engine/implementer.ts`**
- New export: `ImplementerResult` type (was internal, now shared with agent.ts and shell.ts)

**`src/engine/planners/types.ts`**
- Modified: `onPhase` becomes optional (`onPhase?: (phase: string) => void`)

**`src/engine/spec/formatter.ts`**
- New export: `buildFullPrompt(task, context?)` — shared prompt builder replacing 3 inline concatenations
- Modified: `computeTokenBudget` drops 2 always-empty params (`typeDefs`, `implSteps`)

## Shared Type Consolidation (US3)

### Types to Export (currently internal or inline)

| Type | Canonical Location | Consumers |
|------|-------------------|-----------|
| `ImplementerResult` | `implementer.ts` | `implementers/agent.ts`, `implementers/shell.ts` |
| `InvokeResult` | `planners/spawn.ts` (moved from `base.ts`) | All 6 planner backends |
| `CompletionResult` | `openai-stream.ts` | `implementer.ts` |

### Inline Types to Remove

The inline `{ text: string; usage: { inputTokens: number; outputTokens: number } | null }` pattern appears 10+ times across planner backends. After this refactoring, all occurrences will import `InvokeResult` from `planners/spawn.ts`.

The inline `{ success: boolean; output: string; error?: string; usage?: { promptTokens: number; completionTokens: number } }` pattern appears 7 times across implementer backends. After this refactoring, all occurrences will import `ImplementerResult` from `implementer.ts`.

## Named Constants (US6)

| Constant | Value | File | Replaces |
|----------|-------|------|----------|
| `MAX_CLARIFICATION_QUESTIONS` | 5 | `planning.ts` | Magic number at line 92 |
| `DETECTION_TIMEOUT_MS` | 5000 | `detection.ts` | Magic number at lines 44, 48, 77 |
| `STREAM_TIMEOUT_MS` | 60_000 | `openai-stream.ts` | Magic number at line 51 |
| `SEARCH_REPLACE_THRESHOLD` | 200 | `apply.ts` | Magic number at line 33 |
| `DEFAULT_MODEL` | `'claude-sonnet-4-6'` | `agent-sdk.ts` | Magic string at lines 82, 83, 94 |
| `LABEL_COL_WIDTH` | 14 | `help-overlay.tsx` or shared | Magic number in help-overlay and slash-suggestions |
