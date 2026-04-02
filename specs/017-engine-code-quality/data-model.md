# Data Model: Engine Code Quality to 5/5

**Date**: 2026-04-01
**Scope**: New shared abstractions and interface changes introduced by the refactoring

This refactoring does not introduce new persistent data entities. The "data model" for this feature is the set of shared function interfaces and module boundaries.

## New Shared Abstractions

### 1. Output Parsers (`engine/output-parsers.ts`)

**Responsibility**: Transform raw output lines into structured data. Shared by planners and implementers.

**Exported functions**:

- `parseTextLine(line: string): ParsedLine` — Plain text accumulation with optional token regex
- `parseJsonlLine(line: string): ParsedLine` — JSONL event parsing (item.completed, turn.completed, agent_message)
- `parseStreamJsonLine(line: string): ParsedLine` — Claude stream-json format parsing (delegates to `claude-stream.ts` for core parsing)
- `getLineParser(format: OutputFormat): (line: string) => ParsedLine` — Factory that returns the right parser for a given format
- `accumulateUsage(current: TokenUsageSnapshot | null, parsed: { inputTokens: number; outputTokens: number }): TokenUsageSnapshot` — Merge incremental usage into running total

**Key type**:
```
ParsedLine { text?: string; usage?: { inputTokens: number; outputTokens: number }; isResult?: boolean }
```

**Dependency direction**: This module imports only from `types.ts` and `claude-stream.ts`. It is a leaf module — no circular dependency risk.

### 2. Spawn Utility (`planners/base.ts` additions)

**Responsibility**: Manage subprocess lifecycle for planner backends that use stdin-based invocation.

**New exported functions**:

- `spawnWithStdin(opts: SpawnStdinOptions): Promise<SpawnResult>` — Spawn process, write prompt to stdin, buffer stdout lines, classify errors (ENOENT, exit 127, non-zero exit)
- `createGetVersion(command: string, args?: string[]): () => Promise<string | null>` — Factory for the common getVersion pattern
- `createIsAvailable(command: string, opts?: { timeout?: number }): () => Promise<boolean>` — Factory for the common isAvailable pattern

**Key type**:
```
SpawnStdinOptions {
  command: string
  args: string[]
  cwd: string
  stdin?: string
  onLine: (line: string) => void
  onStderr?: (chunk: string) => void
  notFoundMessage: string
}

SpawnResult {
  collectedText: string
  stderrOutput: string
  code: number
}
```

### 3. Process Utility Addition (`utils/process.ts`)

**New exported function**:

- `isENOENT(err: unknown): boolean` — Replaces 8 inline `err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'` checks

### 4. Orchestrator Events (`orchestrator/events.ts`)

**Responsibility**: Event emission and validation result helpers for the orchestrator.

**Exported functions** (relocated from `helpers.ts`):

- `emit(projectDir: string, state: WorkflowState, type: string, data?: Record<string, unknown>): void`
- `emitValidationStart(callbacks: OrchestratorCallbacks): void`
- `emitValidationResult(callbacks: OrchestratorCallbacks, results: ValidationResult[], startTime: number): void`
- `allValidationsPassed(results: ValidationResult[]): boolean`

**Fix**: `emitValidationResult` will call `allValidationsPassed` instead of reimplementing the same logic.

### 5. Task Runner Decomposition (`orchestrator/task-runner.ts`)

**Current**: 2 functions (130 + 39 lines)
**After**: 5+ functions (each under 30 lines)

**New functions**:
- `runLocalRetries(task, error, projectDir, config, context, callbacks, state, startTime): Promise<RetryTierResult>`
- `runTier1Hint(task, error, planner, projectDir, config, context, callbacks, state, startTime): Promise<RetryTierResult>`
- `runTier2Full(task, error, planner, projectDir, config, callbacks, state, startTime): Promise<RetryTierResult>`
- `refreshCurrentCode(task: Task, projectDir: string): void` — Read file into task.currentCode
- `runValidation(task, projectDir, config, callbacks): Promise<{ results: ValidationResult[]; startTime: number }>` — Shared validate+emit pattern

### 6. Type Changes (`types.ts`)

**Modified types**:
- `Config.planner`: Add optional `model?: string` field to eliminate `as any` casts
- New named type `BuildSummaryState = Pick<WorkflowState, 'tasks' | 'completedTasks' | 'escalatedTasks' | 'skippedTasks' | 'failedTasks' | 'tokenUsage'>` — Replaces the 280-char inline type in `buildSummary`

## Module Dependency Changes

### Before (simplified)
```
planners/codex.ts ──→ claude-stream.ts (parseStreamLine)
planners/shell.ts ──→ claude-stream.ts (parseStreamLine)
                  ──→ (inline parseTextLine, parseJsonlLine)
implementers/shell.ts ──→ (inline parseTextLine, parseJsonlLine, parseStreamJsonLine)
```

### After
```
planners/codex.ts ──→ output-parsers.ts ──→ claude-stream.ts
planners/shell.ts ──→ output-parsers.ts ──→ claude-stream.ts
implementers/shell.ts ──→ output-parsers.ts ──→ claude-stream.ts
```

The dependency chain remains acyclic and unidirectional. `output-parsers.ts` is a new leaf node with a single downstream dependency on `claude-stream.ts`.
