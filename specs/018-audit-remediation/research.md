# Research: Audit Remediation

**Source**: 20-agent deep code quality audit (Opus agents, 2026-04-01)
**Coverage**: All files in `src/engine/`, `src/ui/`, `src/hooks/`, `src/utils/`, `src/types.ts`, `tests/`

## R1: Where to Move `refreshCurrentCode` (Breaking Circular Import)

**Decision**: Create `src/engine/orchestrator/helpers.ts` and move `refreshCurrentCode` there.

**Rationale**: `refreshCurrentCode` is a 6-line file-read utility imported by both `task-runner.ts` and `task-loop.ts`, creating a circular dependency. It belongs in neither module — it's a shared utility. A new `helpers.ts` in the orchestrator directory is the natural home, keeping it close to its only consumers without creating cross-module dependencies.

**Alternatives considered**:
- Move to `events.ts` — rejected because `events.ts` is about event emission, not file I/O
- Move to `utils/fs.ts` — rejected because it depends on the `Task` type (engine-specific, not a general utility)
- Inline at both call sites — rejected because it would duplicate the 6 lines

## R2: Where to Move `spawnWithStdin` (Splitting base.ts)

**Decision**: Create `src/engine/planners/spawn.ts` for `spawnWithStdin` and related spawn infrastructure. Create `src/engine/planners/context.ts` for `buildProjectContextMarkdown` + `listDir`.

**Rationale**: `base.ts` is 325 lines with 4 responsibilities. The subprocess spawning (86 lines) and project context building (58 lines) are distinct from the planner factory (116 lines). Keeping them in the `planners/` directory preserves locality — all 6 planner backends import from these modules.

**Alternatives considered**:
- Move `spawnWithStdin` to `utils/process.ts` — rejected because `spawnWithStdin` has planner-specific features (stdin piping, text accumulation, question parsing support) that don't belong in a generic process utility module. The existing `spawnWithStreaming` in `utils/process.ts` is simpler and more general.
- Keep in `base.ts` — rejected because 325 lines violates the 200-line file size guideline.

## R3: Idle Timeout Pattern for Streaming

**Decision**: Reset the timeout timer on each received chunk. Use `clearTimeout` + `setTimeout` in the chunk handler.

**Rationale**: The current absolute timeout (60s from stream start) kills successful long-running streams. The correct semantic is "kill if no data received for 60s" — this is the standard idle timeout pattern used by HTTP clients, WebSocket libraries, and streaming APIs.

**Implementation pattern**:
```
let timer = setTimeout(reject, TIMEOUT);
for await (chunk of stream) {
  clearTimeout(timer);
  timer = setTimeout(reject, TIMEOUT);
  process(chunk);
}
clearTimeout(timer);
```

**Alternatives considered**:
- Keep absolute timeout with higher value — rejected because any fixed absolute value is wrong for variable-length outputs
- Make timeout configurable — not in scope; the 60s idle timeout is a reasonable default

## R4: Typed Timeout Error Detection

**Decision**: Attach an `isTimeout: true` property to the timeout error object using `Object.assign`.

**Rationale**: The project has a "zero classes" constraint. A custom error class (`class StreamTimeoutError extends Error`) violates this. `Object.assign(new Error(...), { isTimeout: true })` is idiomatic for the project's functional style and can be checked with `'isTimeout' in err`.

**Alternatives considered**:
- Custom error class — rejected per constitution principle IV (zero classes)
- Error code property (`err.code = 'STREAM_TIMEOUT'`) — equally valid but `isTimeout` boolean is more concise to check
- Symbol property — over-engineering for this use case

## R5: Options Object Naming Convention

**Decision**: Use `{FunctionName}Options` for exported functions, inline `opts: { ... }` for internal functions with few parameters.

**Rationale**: The codebase already uses this pattern with `EscalationContext` in `task-runner.ts`. Named interfaces make call sites self-documenting and enable autocomplete. For internal helpers with 4-5 params, inline types avoid interface proliferation.

**Canonical examples from this refactoring**:
- `RunTaskLoopOptions` for `runTaskLoop` (exported, 7 remaining params after removing 2 unused)
- `StreamCompletionOptions` for `streamCompletion` (exported, 4 groupable params)
- `ValidateCommitOptions` for `validateCommitAndAdvance` (exported, 10 params → options object)
- Inline `opts: { ... }` for internal helpers like `buildAndRecordUsage`, `runValidationStep`

**Alternatives considered**:
- `{FunctionName}Config` — rejected because `Config` already has a specific meaning in this codebase (yaml config)
- `{FunctionName}Params` — equally valid but `Options` is more conventional in TypeScript ecosystems
- `{FunctionName}Context` — reserved for objects that carry mutable state (like `EscalationContext`)

## R6: Ollama URL Fix Pattern

**Decision**: Strip `/v1` suffix from `apiBase` before constructing native Ollama API URLs. Use `baseUrl.replace(/\/v1\/?$/, '')`.

**Rationale**: The `apiBase` for Ollama is typically `http://localhost:11434/v1` (OpenAI-compatible format), but native Ollama endpoints like `/api/show` and `/api/tags` live at the root (`http://localhost:11434`). The same fix pattern is already used correctly in `detection.ts:63`: `DEFAULT_BASES.ollama.baseURL.replace('/v1', '/api/tags')`. The bug in `providers.ts` simply forgot to apply this.

**Alternatives considered**:
- Derive from `DEFAULT_BASES` — this is a complementary fix: use `DEFAULT_BASES.ollama.baseURL` as the fallback AND strip `/v1` from user-provided `apiBase`

## R7: SummaryView Decomposition Strategy

**Decision**: Extract 5 section components from `SummaryView` (145 lines): `OverviewSection`, `TasksSection`, `TokenUsageSection`, `CostSection`, `TaskBreakdownSection`.

**Rationale**: Each section renders a distinct data slice with its own layout logic. The parent `SummaryView` becomes a ~40-line orchestrator that destructures the `Summary` prop and delegates to children. This matches the pattern already used in `event-card.tsx` (multiple sub-components per event type).

**Alternatives considered**:
- Keep as one component — rejected because 145-line render function violates the 100-line component guideline
- Extract to separate file — rejected because sections are only used within SummaryView; colocating in `summary.tsx` is cleaner

## R8: Language Hint Preservation in Markdown

**Decision**: Pass the original `langHint` from code fence parsing through to `HighlightedCode`. Fall back to plain text rendering for unsupported languages rather than misapplying TypeScript highlighting.

**Rationale**: The current code hardcodes `codeLang = 'typescript'` for everything except `js`/`javascript`. This means ` ```bash `, ` ```json `, ` ```yaml ` blocks get TypeScript syntax coloring, which is visually wrong. Shiki supports many languages natively; passing the hint through lets it handle them correctly.

**Alternatives considered**:
- Maintain a whitelist of supported Shiki languages — over-engineering; Shiki handles unknown languages gracefully
- Only highlight TS/JS, render everything else as plain text — acceptable fallback but loses highlighting for common languages like bash, json, yaml that Shiki handles well

## R9: Theme Prop Drilling vs Context

**Decision**: Pass `theme` as a prop from parent to sub-components. Do not introduce React Context for theme.

**Rationale**: The component trees are shallow (1-2 levels). Context would add complexity for marginal benefit. The `getTheme()` call is cheap (returns a static object), so the issue is not performance but DRY — calling it 13 times independently means 13 potential points of divergence if `getTheme` ever accepts arguments (e.g., dark mode). Prop drilling at 1-2 levels is the right tradeoff per React best practices.

**Alternatives considered**:
- React Context for theme — rejected as over-engineering for 1-2 level prop passing in a CLI app
- Keep calling `getTheme()` everywhere — rejected because it violates DRY and creates divergence risk

## R10: Import Graph Verification

**Decision**: Use `madge` (npm package) to verify zero circular imports after refactoring.

**Rationale**: `madge` is the standard tool for detecting circular dependencies in JavaScript/TypeScript projects. Running `npx madge --circular --extensions ts,tsx src/` will flag any cycles. This can be added as a verification step in the task completion criteria.

**Alternatives considered**:
- Manual grep analysis — error-prone for complex graphs
- `dpdm` — less widely used, similar functionality
- ESLint `import/no-cycle` rule — would require ESLint config changes; `madge` is a one-shot verification

## R11: `SummaryView` Decomposition — Visual Fidelity

**Decision**: The decomposition must produce pixel-identical terminal output. Extract sub-components but preserve all `<Box>`, `<Text>`, spacing, and color props exactly.

**Rationale**: The summary screen is a key part of the user experience. Any visual change would be a regression. The refactoring is purely structural (splitting a large function into smaller ones), not a redesign.

**Verification**: Run the workflow and visually compare the summary output before and after. Alternatively, capture terminal output with `ink-testing-library` and assert equality.

## R12: Quote Style Standardization

**Decision**: Standardize to single quotes in the 3 files that currently use double quotes (`router.tsx`, `screens/home.tsx`, `input-bar.tsx`).

**Rationale**: The entire rest of the codebase uses single quotes. These 3 files are outliers, likely from a different code generation session. Single quotes are the project convention.

**Scope**: Only change import strings and string literals. Do not add a formatter or linter rule — this is a one-time manual fix.
