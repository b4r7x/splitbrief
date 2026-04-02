# Research: State-of-the-Art Code Quality Overhaul

**Date**: 2026-04-02  
**Method**: 20 parallel Opus agents performing deep codebase analysis  
**Scope**: All 60+ source files, 15 test files, cross-file patterns

## 1. Config Validation Type Safety

**Decision**: Replace 19 `as any` casts in `validateConfig` with a properly typed accessor pattern.

**Rationale**: The function accepts `Record<string, unknown>` (from YAML parsing) and immediately bypasses TypeScript via `(config as any)?.planner?.tool` on every field access. A single typed cast at the function entry point or a helper function `get(obj, 'planner.tool')` returning `unknown` with proper narrowing would eliminate all 19 casts while maintaining the same runtime behavior.

**Alternatives considered**:
- `Partial<Config>` parameter type: Rejected because YAML.parse returns `unknown`, not a partial Config. Would still need an unsafe cast at the boundary.
- Zod/io-ts schema validation: Rejected because it introduces a new dependency, violating the zero-new-deps constraint.
- `JSON.parse` reviver: N/A — config is YAML, not JSON.

**Also**: `process.exit(2)` in `loadConfig` must be replaced with throwing/returning errors. The caller (`cli.ts`) should handle the exit decision.

## 2. React State Management Pattern

**Decision**: Refactor `useWorkflow`'s 7 `useState` calls into a single `useReducer` with a typed action discriminated union.

**Rationale**: The 7 state values (`events`, `phase`, `currentTask`, `totalTasks`, `localCount`, `escalatedCount`, `reviewFilePath`) are frequently updated together in `addEvent` (lines 37-45), causing multiple re-renders per event. React's `useReducer` batches updates from a single dispatch into one render cycle. The action types map directly to the existing update patterns: `ADD_EVENT`, `SET_PHASE`, `SET_PROGRESS`, `SET_REVIEW_FILE`, `RESET`.

**Alternatives considered**:
- Zustand/Jotai: Rejected — external state library is overkill for a single hook's internal state.
- Single `useState<WorkflowState>` object: Viable but `useReducer` is more idiomatic for complex state transitions and makes the update patterns explicit.
- Keep 7 `useState` with React 19 automatic batching: React 19 does batch `setState` calls within event handlers, but the updates happen inside an async callback captured by a mount-only `useEffect`, where batching is not guaranteed for all code paths.

## 3. Theme Propagation Architecture

**Decision**: Introduce an `AppContext` React Context providing `{ config, theme, commands, errorMessage, onClearError }` to all components. Components access theme via context instead of calling `getTheme()` directly.

**Rationale**: Currently 6+ UI components call `getTheme()` without passing the user's theme mode, always defaulting to terminal theme. The context pattern:
- Fixes the bug (theme mode flows from config through context)
- Reduces Router props from 19 to ~8
- Eliminates the need to thread theme through every intermediate component
- Aligns with Ink's React model (context is well-supported in Ink 6.x)

**Affected components** (call `getTheme()` without mode):
- `src/ui/event-card.tsx:170`
- `src/ui/header.tsx:25`
- `src/ui/picker.tsx:6`
- `src/ui/conversation-flow.tsx:163`
- `src/ui/diff-view.tsx` (imports getTheme)
- `src/ui/pipeline-bar.tsx` (imports getTheme)
- `src/ui/cost-footer.tsx` (imports getTheme)
- `src/ui/task-summary.tsx` (imports getTheme)

**Components already correct** (receive theme as prop):
- `src/ui/command-palette.tsx`
- `src/ui/help-overlay.tsx`
- `src/ui/slash-suggestions.tsx`

**Alternatives considered**:
- Pass theme as prop to every component: More changes, same result, creates deeper prop threading. Rejected for maintenance burden.
- Module-level theme variable set at app init: Would work but is not reactive to potential runtime theme changes and doesn't solve the prop drilling problem.

## 4. Token Usage Type Unification

**Decision**: Define shared named types in `src/types.ts`:
- `PlannerTokenUsage = { inputTokens: number; outputTokens: number }`
- `ImplementerTokenUsage = { promptTokens: number; completionTokens: number }`

**Rationale**: The inline type `{ inputTokens: number; outputTokens: number }` appears 15+ times across planner modules, and `{ promptTokens: number; completionTokens: number }` appears 5+ times in implementer modules. These naming differences reflect the Anthropic vs OpenAI API conventions. Rather than force a single naming convention (which would require mapping at every boundary), define both as named types. The orchestrator's `tokens.ts` can use both with a clear normalization function.

**Alternatives considered**:
- Single unified `TokenUsage` type with `input`/`output` field names: Would require renaming at the OpenAI SDK boundary (implementer side). More invasive for marginal benefit.
- Keep inline types but add a lint rule: Doesn't solve the maintenance problem.

## 5. Line-Buffer Utility Design

**Decision**: Add `createLineBuffer(onLine: (line: string) => void): { push(chunk: string): void; flush(): void }` to `src/utils/process.ts`.

**Rationale**: The stdout line-buffering pattern (accumulate into buffer, split on `\n`, pop incomplete trailing fragment, iterate complete lines, flush on close) is duplicated in 4 locations:
- `src/utils/process.ts:43-49` (stdout in spawnWithStreaming)
- `src/utils/process.ts:52-58` (stderr in spawnWithStreaming)
- `src/engine/planners/spawn.ts:44-52`
- `src/engine/implementers/shell.ts:76-89`

A shared utility returns a `push` function (for `data` events) and `flush` function (for `close` events), encapsulating the buffer management.

**Alternatives considered**:
- Node.js `readline.createInterface`: Overkill for simple line splitting, adds complexity around readline's event-based API.
- Transform stream: Works but adds streaming abstraction overhead for what is conceptually a string accumulator.

## 6. Shell Implementer Spawn Deduplication

**Decision**: Refactor `spawnShellImplementer` in `src/engine/implementers/shell.ts` (~90 lines) to reuse `spawnWithStdin` from `src/engine/planners/spawn.ts`, adding a line-parsing callback option.

**Rationale**: Both functions perform identical lifecycle management: spawn with ENOENT handling, `activeProcesses` tracking, stdout/stderr buffering, error event handling, close event with code-127 check. The shell implementer adds output-format-specific line parsing on top. The shared `spawnWithStdin` already accepts `onLine` and `onRawOutput` callbacks, making extension straightforward.

**Alternatives considered**:
- Keep separate implementations: Rejected because any fix to the spawn lifecycle (e.g., timeout handling) must be applied in both places.
- Create a new shared `spawnImplementer` function: Unnecessary indirection when `spawnWithStdin` already does 90% of what's needed.

## 7. Picker Component Anti-Patterns

**Decision**: Move auto-selection logic from `useEffect` to the parent component or `useState` initializer. Remove the `useRef` guard and `resolved` flag.

**Rationale**: The picker's `useEffect` (lines 50-71) calls `onComplete`/`onError` as side effects during mount, guarded by a `resolved` ref to prevent double-invocation in StrictMode. This is the "useEffect for derived state/actions" anti-pattern. The auto-selection can be computed before mounting the Picker:
- If only one planner is available, skip the picker entirely
- If only one implementer model is available, auto-select it
- Parent component handles these cases before rendering Picker

**Alternatives considered**:
- Keep useEffect but improve the guard: Still an anti-pattern, just better-guarded.
- Lazy state initializer: Could compute the initial step and call onComplete synchronously in useState init, but mixing callbacks with initialization is equally fragile.

## 8. Dead Code Inventory

**Decision**: Remove all verified dead code. Un-export symbols that are only used internally.

**Findings from audit**:
- **Dead functions**: `acquireLock`, `releaseLock` in `src/utils/fs.ts` — exported, defined, never called anywhere. Remove entirely.
- **Dead mutable variable**: `currentThemeName` in `src/engine/highlight.ts` — `let` but never mutated. Change to `const`.
- **Dead exports (25+)**: Type interfaces exported but never imported externally. Un-export (remove `export` keyword) for: `CompletionResult`, `StreamCompletionOptions`, `StreamParseResult`, `ConfigError`, `InvokeFn`, `PlannerBaseConfig`, `ImplementTaskOptions`, `RetryTaskOptions`, `GenEventEmitter`, `ConversationFlowProps`, `ShellImplementerOptions`, `RetryShellOptions`, `AgentImplementerOptions`, `RetryAgentOptions`, `RetryResult`, `ValidateCommitOptions`, `HandleRetryOptions`, `BuildSummaryOptions`, `PlanningPhaseOptions`, `ParsedLine`, `BREAKPOINTS`, `Block`, `RunTaskLoopOptions`, `SHORTCUTS`, `formatRelativeTime` (from home.tsx — move to utils/format.ts instead).
- **Redundant screen state**: `use-router.ts` has `screen` state that is derivable from `routeData.screen`. Remove.

**Alternatives considered**:
- Keep dead exports "in case they're needed later": Rejected per YAGNI principle and project constitution.

## 9. Conversation Flow Extraction

**Decision**: Extract `groupEventsIntoSections`, `estimateEventHeight`, and `getVisibleWindow` from `src/ui/conversation-flow.tsx` into a new `src/utils/event-sections.ts` pure module.

**Rationale**: These are pure algorithmic functions (no React/Ink dependencies) that perform event grouping and virtual scroll calculations. They are already exported and tested, but importing them requires importing a React component file. Extracting them:
- Makes them testable without React
- Follows the project convention of keeping pure logic in `utils/` or `engine/`
- Reduces `conversation-flow.tsx` from 274 lines to ~120 lines (rendering only)

**Alternatives considered**:
- Put in `engine/`: Rejected because event grouping is a UI concern (groups events for display), not an engine concern.
- Keep in component file: Works but violates the "pure logic separate from UI" convention.

## 10. Review-View Async File Reading

**Decision**: Replace `readFileSync` in `src/ui/review-view.tsx` with async `fs.readFile` inside a `useEffect` with proper cancellation.

**Rationale**: `readFileSync` blocks the Ink event loop during the React render cycle. While the files are small (markdown specs), this is architecturally wrong for a React component. The standard pattern is: `useEffect` with `filePath` dependency → `readFile` → `setContent` → cleanup with cancelled flag.

Also fix the controlled/uncontrolled `offset` hybrid: either fully controlled (parent manages offset) or fully uncontrolled (component manages offset internally, resets on filePath change).

**Alternatives considered**:
- Keep readFileSync with a size guard: Still blocks the event loop, just for less time.
- Suspense: Not available in Ink 6.x for data fetching.

## 11. Formatter DRY Violation

**Decision**: Extract the duplicated code-context resolution block (~20 lines) from `formatTaskPrompt` and `formatRetryPrompt` into a shared `insertCodeContext(sections, task, budget?)` helper.

**Rationale**: Lines 156-176 in `formatTaskPrompt` and lines 203-227 in `formatRetryPrompt` perform identical logic: check action/currentCode, extract function name from signature regex, call `resolveCodeContext`, call `insertCodeBeforeConstraints`. The only difference is whether a token budget is passed. A shared helper with optional budget parameter eliminates the duplication.

## 12. Orchestrator DRY Fixes

**Decision**: Three targeted DRY fixes in the orchestrator:

1. **buildSummary options**: Extract `const summaryBase = { feature, startTime, plannerTool: config.planner.tool, implementerProvider: config.implementer.provider }` at the top of `runWorkflow()`, then spread `{ ...summaryBase, state }` at each of the 5 call sites.

2. **addXxxUsage consolidation**: Replace 3 near-identical functions (`addPlannerUsage`, `addImplementerUsage`, `addEscalationUsage`) with a single generic `addUsage(state, category: 'planner' | 'implementer' | 'escalation', usage)`. The category determines which fields to update.

3. **simpleGit double-cast**: Export `getGit` from `src/utils/git.ts` and import it in `src/engine/implementers/agent.ts` instead of duplicating the `simpleGit as unknown as (dir: string) => SimpleGit` workaround.
