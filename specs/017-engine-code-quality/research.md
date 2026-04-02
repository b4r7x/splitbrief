# Research: Engine Code Quality to 5/5

**Date**: 2026-04-01
**Method**: 20 parallel Opus agents performing deep code review across all `src/engine/` modules

## 1. Duplication Inventory

### Decision: Create `engine/output-parsers.ts` as the shared parser module
**Rationale**: Output parsers are the single largest source of duplication (~150 lines across 5 files). They are leaf functions with no engine dependencies beyond types, making extraction risk-free.
**Alternatives considered**:
- Putting parsers in `claude-stream.ts` (rejected: that file is Claude-specific, parsers are format-specific)
- Putting parsers in `planners/base.ts` (rejected: implementers also need them)
- Per-format parser files (rejected: over-decomposition for ~4 small functions)

### Decision: Add spawn utility to `planners/base.ts`
**Rationale**: The spawn+buffer+ENOENT pattern is planner-specific infrastructure. The existing `spawnWithStreaming` in `utils/process.ts` handles stdout-only spawning; the stdin-pipe variant needed by escalators and shell planners extends the same concept but with different stdio configuration. Placing it in `base.ts` keeps the planner abstraction self-contained.
**Alternatives considered**:
- New `utils/spawn-stdin.ts` (rejected: only planners and final-review use stdin-pipe spawning)
- Extending `spawnWithStreaming` with options (rejected: would change a stable utility used by all backends)

### Decision: Add `isENOENT(err)` to `utils/process.ts`
**Rationale**: ENOENT checking is a process-level concern already living in `utils/process.ts`. 8 call sites across planners, implementers, and validator will use it.
**Alternatives considered**:
- Inline in each file (status quo, rejected: 8 copies of the same 3-line check)

## 2. Function Decomposition Strategy

### Decision: Decompose `handleRetryAndEscalation` into 3 tier functions
**Rationale**: The function has 3 natural boundaries (retry loop, hint escalation, full escalation), each following the same implement→validate→commit pattern. Extracting them makes each independently testable and reduces the coordinator to ~20 lines.
**Alternatives considered**:
- Table-driven approach with a tier config array (rejected: tiers have different parameters and callbacks)
- Keeping as-is with better comments (rejected: doesn't address the 130-line size or 4-level nesting)

### Decision: Extract `buildAndRecordUsage` from `runTaskLoop`
**Rationale**: The `TaskTokenUsage` construction + push + emit pattern appears 4 times in the loop with identical structure. A helper reduces the loop body by ~40 lines.
**Alternatives considered**:
- Only extracting the construction (rejected: the push+emit always follows, so extract the full pattern)

### Decision: Extract `runValidationStep` from `validateTask`
**Rationale**: The 3 validation stages (typecheck, lint, test) follow an identical try/catch/ENOENT/exit-code pattern. A parameterized helper with `stage`, `command`, `args`, and `errorSourcePreference` eliminates ~80 lines of duplication.
**Alternatives considered**:
- Array-driven validation config (rejected: lint has a detection step that doesn't fit a simple config; better to have the helper accept command+args directly)

### Decision: Extract `buildTaskSections` from `formatTaskPrompt`/`formatRetryPrompt`
**Rationale**: Both formatters build the same markdown section array (title, action, file, description, signature, typeDefs, implSteps, tests, constraints). Extracting shared assembly saves ~30 lines and ensures consistency.
**Alternatives considered**:
- Only sharing the constraints block (rejected: the full section list is duplicated, not just constraints)

## 3. helpers.ts Decomposition

### Decision: Split into `orchestrator/events.ts` + relocate remaining functions
**Rationale**: `helpers.ts` bundles 8 functions from 4 unrelated concerns. The event functions (`emit`, `emitValidationStart`, `emitValidationResult`, `allValidationsPassed`) form a cohesive group. Other functions relocate to existing modules:
- `supportsConversational` → `planners/base.ts` (planner concern)
- `persistClarifications` → `spec/parser.ts` or new `spec/persistence.ts` (spec file I/O)
- `buildContext` → stays in orchestrator as an inline helper in `index.ts` or `planning.ts` (only used there)
- `hasDependencyFailed` → `task-loop.ts` (only used there, 4-line predicate)
**Alternatives considered**:
- Renaming to `orchestrator/utils.ts` (rejected: same grab-bag, different name)
- Creating 4 separate files (rejected: over-decomposition for functions under 20 lines each)

## 4. Dead Code Audit

| Dead Item | Location | Evidence |
|-----------|----------|----------|
| `validateProviderCredentials` | `providers.ts:26-38` | Grep: zero imports across entire codebase |
| `import { buildSummary }` | `task-loop.ts:11` | Never referenced in file body |
| `import { ProjectContext }` | `planners/types.ts:1` | Never referenced in file body |
| `stderrOutput` variable | `implementers/agent.ts:76` | Assigned, accumulated at line 91, never read |
| `BREAKPOINTS.SMALL/LARGE` | `hooks/use-terminal-size.ts:5,7` | Grep: only `BREAKPOINTS.MEDIUM` used |
| `listDir` export | `planners/base.ts:72` | Only used internally at lines 66, 86 |
| `buildProjectContext` export | `planners/base.ts:35` | Only used internally at line 106 |
| `StepFinishUsage.cost` field | `planners/opencode.ts:8` | Parser at line 27 only accesses `usage.tokens` |
| Redundant dynamic `import()` of `runCommand` | `codex.ts:135`, `opencode.ts:121`, `aider.ts:109` | Already statically imported at top of each file |

## 5. Naming Corrections

| Current Name | Issue | Proposed Name |
|-------------|-------|---------------|
| `LOCAL_PRICING` | Has `isLocal: false` | `SHELL_PRICING` or `ZERO_PRICING` |
| `WRITE_TOOLS` | Contains 3 read tools + 1 write | `ALLOWED_TOOLS` |
| `spawnClaudeEscalator` | "Escalator" is misleading; used for escalation, regeneration, and any stdin-based invocation | `spawnClaudeWithStdin` |
| `retryResult2` | Numbered variable name | `validationRetryResult` |

## 6. Behavioral Quality Gaps

### Decision: Forward `onEvent` to shell/agent implementer backends (FR-020)
**Rationale**: The UI receives no status events for non-OpenAI backends. This is a completeness gap — the `OrchestratorCallbacks` interface already supports it, the OpenAI path emits events, but shell/agent paths silently skip. Adding `onEvent` to the shell/agent function signatures and emitting equivalent events closes the gap.
**Alternatives considered**:
- Emitting events from the routing layer in `implementer.ts` (rejected: the routing layer doesn't have timing/progress information)

### Decision: Handle stderr in `final-review.ts` (FR-023)
**Rationale**: `spawnClaudeEscalator` captures stderr and includes it in error messages. `runFinalReview` silently discards stderr. This means Claude CLI diagnostic output during final review is lost, making failures harder to debug.
**Alternatives considered**:
- Only logging stderr to disk (rejected: error messages should include relevant diagnostic info inline)

## 7. Type Safety

### Decision: Add `model?: string` to planner config type
**Rationale**: 3 planner backends access `config.planner.model` via `as any` or `as { model?: string }` casts. Adding an optional `model` field to the `Config.planner` type makes this type-safe.
**Alternatives considered**:
- Discriminated union on `Config.planner` by tool name (rejected: over-engineering for a single optional field)

### Decision: Replace `buildSummary` inline type with `Pick<WorkflowState, ...>`
**Rationale**: The ~280-character inline structural type is unreadable. `Pick<WorkflowState, 'tasks' | 'completedTasks' | 'escalatedTasks' | 'skippedTasks' | 'failedTasks' | 'tokenUsage'>` is equivalent and self-documenting.
**Alternatives considered**:
- Accepting full `WorkflowState` (rejected: function only uses 6 fields, `Pick` documents the contract)

## 8. Pre-Existing Test Failure

### Decision: Fix the orchestrator test "accepts a savedState parameter (6th argument)"
**Rationale**: This test fails on the 016 branch due to the orchestrator decomposition changing `runWorkflow`'s signature. The test must be updated to match the new signature before this refactoring can claim all tests pass (FR-018).
**Alternatives considered**:
- Skipping the test (rejected: constitution V requires all tests pass)
