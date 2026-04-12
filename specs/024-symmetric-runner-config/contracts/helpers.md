# Contract: Runner helpers & builder

**Files**:
- `src/core/config/runner-config.ts` (NEW) — display / narrowing helpers
- `src/core/config/build-runner.ts` (NEW) — unified constructor
- `src/core/providers/catalog.ts` (MODIFIED) — add `resolveDefaultApiBase`

## Purpose

Consolidate the "read from a runner config" and "construct a new runner config" operations into single shared functions. Eliminates scattered `config.implementer.tool` reads and per-role duplicate builders.

## `runner-config.ts` exports

```ts
export type RunnerConfig = PlannerConfig | ImplementerConfig;

export function getRunnerDisplayName(runner: RunnerConfig): string;
export function getRunnerCommand(runner: RunnerConfig): string | undefined;
export function getRunnerApiKey(runner: RunnerConfig): string | undefined;
```

### `getRunnerDisplayName`

```ts
function getRunnerDisplayName(runner: RunnerConfig): string {
  switch (runner.kind) {
    case 'cli':       return runner.tool;
    case 'api':       return runner.provider;
    case 'shell':     return 'shell';
    case 'agent':     return 'agent';
    case 'agent-sdk': return 'agent-sdk';
  }
}
```

**Contract**:
- Exhaustive switch with a `never` check for the default branch; adding a new runner kind will cause a compile error here.
- Returns a stable, human-readable string suitable for TUI display, cost calculation lookup keys, and `state.json` display fields.
- For CLI runners, the tool identifier doubles as the display name.
- For API runners, the provider name is the display name (this is what users recognize — they pick "ollama" or "anthropic", not "api").

### `getRunnerCommand`

Returns the shell command string for shell/agent variants, `undefined` otherwise.

```ts
function getRunnerCommand(runner: RunnerConfig): string | undefined {
  return runner.kind === 'shell' || runner.kind === 'agent'
    ? runner.command
    : undefined;
}
```

### `getRunnerApiKey`

Returns the API key for api/agent-sdk variants, `undefined` otherwise.

```ts
function getRunnerApiKey(runner: RunnerConfig): string | undefined {
  if (runner.kind === 'api' || runner.kind === 'agent-sdk') return runner.apiKey;
  return undefined;
}
```

## `build-runner.ts` exports

```ts
export type Role = 'planner' | 'implementer';

export interface BuildRunnerOpts { /* see data-model.md */ }

export function buildRunnerConfig(
  role: Role,
  opts: BuildRunnerOpts,
): PlannerConfig | ImplementerConfig;
```

### `buildRunnerConfig` contract

**Input**: A role hint and a loose set of user intents (from CLI flags, picker selections, or custom command input).

**Output**: A fully valid `PlannerConfig` or `ImplementerConfig`, guaranteed to pass `XxxConfigSchema.parse()`.

**Behavior**:
1. **Decide the kind**:
   - If `opts.kind` is provided, use it directly.
   - Else if `opts.tool` is in `CLI_TOOL_IDS` → `cli`.
   - Else if `opts.apiBase` is provided → `api`.
   - Else if `opts.command` is provided → `shell`.
   - Else if `opts.existing` is provided → inherit its kind.
   - Else → error naming the missing information.

2. **For each kind, construct the variant**:
   - `cli`: requires `tool` (validated against `CLI_TOOL_IDS`); other fields optional.
   - `api`: requires `provider` (any non-empty string) and `apiBase` (auto-fill from `resolveDefaultApiBase(provider)` if missing AND provider is known; otherwise throw).
   - `shell`: requires `command`.
   - `agent`: requires `command`.
   - `agent-sdk`: no required transport fields.

3. **Merge generation params**: Apply `opts.model`, `opts.contextLength`, `opts.temperature`, `opts.timeout`, `opts.customModels`. If `opts.existing` is provided, unspecified params inherit from it.

4. **Apply role-specific rules**:
   - Planner: `model` may be omitted (optional on planner variants).
   - Implementer: `model` is required; throw if neither `opts.model` nor `opts.existing.model` is set.

5. **Return** a fully valid config. The result MUST pass `PlannerConfigSchema.parse()` or `ImplementerConfigSchema.parse()` without errors.

**Error cases** (all throw with actionable messages):
- Unknown kind string
- Tool not in `CLI_TOOL_IDS` (for cli kind)
- Unknown provider without `apiBase` (for api kind)
- Empty or missing `command` (for shell/agent kinds)
- Missing `model` on implementer construction

### Consumer replacement map

These old call sites all delegate to `buildRunnerConfig`:

| Old | New |
|---|---|
| `src/core/config/planner-config.ts:buildPlannerConfig` | `buildRunnerConfig('planner', opts)` |
| `src/core/types/schemas/config.ts:patchImplementerConfig` | `buildRunnerConfig('implementer', { ...opts, existing })` |
| `src/stores/config.ts:applyPlannerOverrides` | delegate via `buildRunnerConfig('planner', ...)` |
| `src/stores/config.ts` implementer override path | delegate via `buildRunnerConfig('implementer', ...)` |
| `src/components/overlays/tool-model-picker/config-transforms.ts:commitPlannerSelection` | delegate via `buildRunnerConfig('planner', ...)` |
| `src/components/overlays/tool-model-picker/config-transforms.ts:commitImplementerSelection` | delegate via `buildRunnerConfig('implementer', ...)` |
| `src/components/overlays/tool-model-picker/config-transforms.ts:commitCustomCommand` | delegate via `buildRunnerConfig(role, { kind: 'shell', command })` |
| `src/components/overlays/tool-model-picker/config-transforms.ts:commitCustomModel` | delegate via `buildRunnerConfig(role, { ...opts, model, customModels })` |

## `resolveDefaultApiBase` contract

**File**: `src/core/providers/catalog.ts` (MODIFIED)

```ts
const KNOWN_API_BASE_URLS: Record<string, string> = {
  ollama:     'http://localhost:11434/v1',
  'lm-studio':'http://localhost:1234/v1',
  anthropic:  'https://api.anthropic.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek:   'https://api.deepseek.com/v1',
};

export function resolveDefaultApiBase(provider: string): string | null {
  return KNOWN_API_BASE_URLS[provider] ?? null;
}
```

### Contract

- Input: any non-empty provider string.
- Output: the known default base URL, or `null` for unknown providers.
- **Single source of truth**. Migration, picker UI, default config creation, and `buildRunnerConfig` all call this function. No parallel tables anywhere.

### Consumers

- `src/core/config/migration.ts:migrateRunnerV1ToV2` (backfill during migration)
- `src/core/config/build-runner.ts:buildRunnerConfig` (auto-fill during construction)
- `src/core/config/loading.ts:createDefaultConfig` (populate default)
- `src/components/overlays/tool-model-picker/picker-catalog.ts` (show user what apiBase they'll get)
