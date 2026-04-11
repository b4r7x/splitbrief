# Data Model — Symmetric Runner Config

## Entity overview

| Entity | Layer | Purpose |
|---|---|---|
| `RunnerKind` | enum | Closed set of 5 discriminant values |
| `CliToolId` | enum | Closed set of valid CLI tool identifiers |
| `CliRunnerFields` | zod field block | Fields required/allowed for `kind: 'cli'` |
| `ApiRunnerFields` | zod field block | Fields required/allowed for `kind: 'api'` |
| `ShellRunnerFields` | zod field block | Fields required/allowed for `kind: 'shell'` |
| `AgentRunnerFields` | zod field block | Fields required/allowed for `kind: 'agent'` |
| `AgentSdkRunnerFields` | zod field block | Fields required/allowed for `kind: 'agent-sdk'` |
| `GenerationCommonFields` | zod field block | Optional generation params shared across both roles |
| `PlannerConfig` | zod discriminated union | Full planner config shape (5 variants) |
| `ImplementerConfig` | zod discriminated union | Full implementer config shape (5 variants) |
| `Config` | zod object | Root config file shape, includes `version: 2` |
| `RunnerConfig` | TS type alias | Union of `PlannerConfig` and `ImplementerConfig` — for helper functions |
| `BuildRunnerOpts` | TS interface | Input to `buildRunnerConfig(role, opts)` constructor |
| `KnownProvider` | map | `provider id → default apiBase URL` lookup |

---

## `RunnerKind`

Closed set of 5 discriminant values.

```ts
const RUNNER_KINDS = ['cli', 'api', 'shell', 'agent', 'agent-sdk'] as const;
type RunnerKind = (typeof RUNNER_KINDS)[number];
```

Both `PlannerConfig['kind']` and `ImplementerConfig['kind']` are exactly this set.

---

## `CliToolId`

Closed set of valid CLI tool identifiers, used as the `tool` value for the `cli` runner kind.

```ts
const CLI_TOOL_IDS = ['claude-code', 'codex', 'opencode', 'aider', 'copilot', 'kilo-code'] as const;
type CliToolId = (typeof CLI_TOOL_IDS)[number];
```

Adding a new CLI tool requires editing **this list only** — no schema variant duplication, no picker edit, no dispatch branch. Type checking will flag every place that needs follow-up handling.

---

## Runner field blocks

Each of these defines a zod raw-shape object (not a schema). They are spread into composed variant schemas in `planner-config.ts` and `implementer-config.ts`.

### `CliRunnerFields`

```ts
{
  kind: z.literal('cli'),
  tool: CliToolIdSchema,                  // z.enum(CLI_TOOL_IDS)
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
}
```

Invariants:
- `kind` is the discriminant — must be exactly `'cli'`.
- `tool` is required and must be in `CLI_TOOL_IDS`.
- `args` and `outputFormat` are optional; defaults supplied at runtime if needed.

### `ApiRunnerFields`

```ts
{
  kind: z.literal('api'),
  provider: z.string().min(1),
  apiBase: z.string().min(1),
  apiKey: z.string().optional(),
}
```

Invariants:
- `kind` must be `'api'`.
- `provider` is any non-empty string — supports both known vendors (`ollama`, `anthropic`) and custom self-hosted names.
- `apiBase` is **always required**. For known providers, migration auto-fills it via `resolveDefaultApiBase`; for custom providers, the user must supply it explicitly.
- `apiKey` is optional; taken from env vars at runtime if not set.

### `ShellRunnerFields`

```ts
{
  kind: z.literal('shell'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
}
```

Invariants:
- `kind` must be `'shell'`.
- `command` is required and non-empty. No `?? ''` fallback anywhere in the codebase can produce an empty-string command.
- Runtime behavior: `extractsCode: true`; the command's stdout is parsed for code blocks.

### `AgentRunnerFields`

```ts
{
  kind: z.literal('agent'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
}
```

Invariants:
- `kind` must be `'agent'`.
- `command` is required and non-empty.
- Runtime behavior: `extractsCode: false`; the command writes files directly and the runtime uses filesystem detection (`detectChanges`) to verify the operation succeeded.

Note: `ShellRunnerFields` and `AgentRunnerFields` look identical at the schema level. The semantic difference lives in the runtime wrappers (`shell.ts` vs `agent.ts`). Two kinds are preserved because merging them would force users to configure a behavioral flag (`extractsCode`) that the two names already imply.

### `AgentSdkRunnerFields`

```ts
{
  kind: z.literal('agent-sdk'),
  apiKey: z.string().optional(),
}
```

Invariants:
- `kind` must be `'agent-sdk'`.
- `apiKey` is optional; taken from `ANTHROPIC_API_KEY` env var if not set.
- No transport identifier needed; the runtime loads the `@anthropic-ai/claude-agent-sdk` peer dep via `loadSdk`.

### `GenerationCommonFields`

```ts
{
  model: z.string().min(1),
  customModels: z.array(z.string()).optional(),
  contextLength: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeout: z.number().positive().max(600000).optional(),
}
```

Shared between `PlannerConfig` and `ImplementerConfig`. Role-specific schemas override `model` to optional on the planner side (some CLI planners auto-select their default model).

---

## `PlannerConfig`

```ts
const PlannerCommonFields = {
  ...GenerationCommonFields,
  model: z.string().min(1).optional(),    // optional on planner
};

const PlannerConfigSchema = z.discriminatedUnion('kind', [
  z.object({ ...CliRunnerFields,      ...PlannerCommonFields }),
  z.object({ ...ApiRunnerFields,      ...PlannerCommonFields }),
  z.object({ ...ShellRunnerFields,    ...PlannerCommonFields }),
  z.object({ ...AgentRunnerFields,    ...PlannerCommonFields }),
  z.object({ ...AgentSdkRunnerFields, ...PlannerCommonFields }),
]);

type PlannerConfig = z.infer<typeof PlannerConfigSchema>;
```

Per-variant narrowing types (consumed by runtime factory functions like `createApiPlanner`, `createShellPlanner`):

```ts
type CliPlannerConfig = Extract<PlannerConfig, { kind: 'cli' }>;
type ApiPlannerConfig = Extract<PlannerConfig, { kind: 'api' }>;
type ShellPlannerConfig = Extract<PlannerConfig, { kind: 'shell' }>;
type AgentPlannerConfig = Extract<PlannerConfig, { kind: 'agent' }>;
type AgentSdkPlannerConfig = Extract<PlannerConfig, { kind: 'agent-sdk' }>;
```

---

## `ImplementerConfig`

```ts
const ImplementerConfigSchema = z.discriminatedUnion('kind', [
  z.object({ ...CliRunnerFields,      ...GenerationCommonFields }),
  z.object({ ...ApiRunnerFields,      ...GenerationCommonFields }),
  z.object({ ...ShellRunnerFields,    ...GenerationCommonFields }),
  z.object({ ...AgentRunnerFields,    ...GenerationCommonFields }),
  z.object({ ...AgentSdkRunnerFields, ...GenerationCommonFields }),
]);

type ImplementerConfig = z.infer<typeof ImplementerConfigSchema>;

type CliImplementerConfig = Extract<ImplementerConfig, { kind: 'cli' }>;
type ApiImplementerConfig = Extract<ImplementerConfig, { kind: 'api' }>;
type ShellImplementerConfig = Extract<ImplementerConfig, { kind: 'shell' }>;
type AgentImplementerConfig = Extract<ImplementerConfig, { kind: 'agent' }>;
type AgentSdkImplementerConfig = Extract<ImplementerConfig, { kind: 'agent-sdk' }>;
```

The implementer uses `GenerationCommonFields` directly (no alias), meaning `model` is required. Local models need an explicit model identifier to load.

---

## Root `Config`

```ts
const ConfigSchema = z.object({
  version: z.literal(2),
  planner: PlannerConfigSchema,
  implementer: ImplementerConfigSchema,
  validation: z.object({
    typecheck: z.boolean(),
    lint: z.boolean(),
    test: z.boolean(),
    testCommand: z.string().min(1),
  }),
  workflow: z.object({
    autoApproveSpec: z.boolean(),
    autoApprovePlan: z.boolean(),
    maxRetries: z.number().int().min(0),
    commitStrategy: CommitStrategySchema,
    mode: WorkflowModeSchema.optional(),
    maxBudget: z.number().positive().optional(),
  }),
  theme: ThemeModeSchema.optional(),
  shikiTheme: ShikiThemeSchema.optional(),
  sessions: z.object({
    scope: z.enum(['project', 'global']).optional(),
  }).optional(),
  escalation: EscalationConfigSchema.optional(),
});

type Config = z.infer<typeof ConfigSchema>;
```

The only change from v1: `version: z.literal(2)` added at the top. Everything below `planner` and `implementer` is unchanged.

---

## `RunnerConfig` (helper alias)

```ts
type RunnerConfig = PlannerConfig | ImplementerConfig;
```

Used by the three shared helper functions:

```ts
function getRunnerDisplayName(runner: RunnerConfig): string
function getRunnerCommand(runner: RunnerConfig): string | undefined
function getRunnerApiKey(runner: RunnerConfig): string | undefined
```

These helpers switch on `runner.kind` with exhaustive narrowing and return the appropriate string/undefined.

---

## `BuildRunnerOpts`

```ts
interface BuildRunnerOpts {
  kind?: RunnerKind | undefined;
  tool?: string | undefined;          // cli: tool id; api: provider name
  model?: string | undefined;
  apiBase?: string | undefined;
  apiKey?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  outputFormat?: OutputFormat | undefined;
  contextLength?: number | undefined;
  temperature?: number | undefined;
  timeout?: number | undefined;
  customModels?: string[] | undefined;
  existing?: RunnerConfig | undefined;
}
```

Passed to `buildRunnerConfig(role: 'planner' | 'implementer', opts: BuildRunnerOpts): PlannerConfig | ImplementerConfig`. The constructor decides which variant to construct based on `opts.kind` first, then falls back to shape inference (`tool` present → cli, `apiBase` present → api, `command` present → shell). It throws if required fields cannot be resolved for the chosen kind — never returns an invalid state.

Consumers:
- CLI overrides (`stores/config.ts:applyPlannerOverrides`, `applyImplementerOverrides`)
- Picker commits (`config-transforms.ts:commitPlannerSelection`, `commitImplementerSelection`)
- Custom command commits (`config-transforms.ts:commitCustomCommand`)
- Custom model commits (`config-transforms.ts:commitCustomModel`)
- Default config creation (`loading.ts:createDefaultConfig`)

---

## `KnownProvider` catalog

```ts
const KNOWN_API_BASE_URLS: Record<string, string> = {
  ollama:     'http://localhost:11434/v1',
  'lm-studio':'http://localhost:1234/v1',
  anthropic:  'https://api.anthropic.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek:   'https://api.deepseek.com/v1',
};

function resolveDefaultApiBase(provider: string): string | null {
  return KNOWN_API_BASE_URLS[provider] ?? null;
}
```

Single source of truth used by migration, picker (via `buildRunnerConfig`), and default config creation.

---

## Migration shape (v1 → v2)

### Legacy shapes to handle

1. **Legacy CLI-tool-as-kind** (implementer only pre-refactor):
   ```yaml
   implementer:
     kind: claude-code           # was a valid kind in v1
     tool: claude-code           # redundant in v1
     model: opus-4
     ...
   ```
   → becomes:
   ```yaml
   implementer:
     kind: cli
     tool: claude-code
     model: opus-4
     ...
   ```

2. **Legacy API-as-tool** (both roles):
   ```yaml
   implementer:
     kind: api
     tool: ollama                # was the provider name in v1
     model: qwen2.5:7b
     ...
   ```
   → becomes:
   ```yaml
   implementer:
     kind: api
     provider: ollama
     apiBase: http://localhost:11434/v1    # auto-filled from catalog
     model: qwen2.5:7b
     ...
   ```

3. **Missing `kind` field** (shape-inferred):
   - If `tool` is in `CLI_TOOL_IDS` → infer `kind: 'cli'`
   - If `apiBase` is present → infer `kind: 'api'`
   - If `command` is present → infer `kind: 'shell'`
   - Otherwise → default to `kind: 'api'` with role default provider (implementer: `'ollama'`, planner: `'anthropic'`)

4. **Custom provider without `apiBase`**: throw a clear error naming the provider, listing known providers, and instructing the user to set `apiBase` explicitly.

### Migration state transitions

```text
disk (v1 shape)
  → YAML parse
  → fromYaml (camelCase conversion)
  → migrateConfig (detects version, dispatches to migrateV1ToV2)
  → validateConfig (zod parse against v2 schema)
  → in-memory Config

on next write:
  in-memory Config (v2) → toYaml → disk (v2 shape)
```

No state.json migration — workflow state stores only display strings.

---

## Relationships

```text
ConfigSchema (root)
  ├── planner: PlannerConfigSchema ─────┐
  │     ├── cli variant ── CliRunnerFields     + PlannerCommonFields
  │     ├── api variant ── ApiRunnerFields     + PlannerCommonFields
  │     ├── shell variant ── ShellRunnerFields  + PlannerCommonFields
  │     ├── agent variant ── AgentRunnerFields  + PlannerCommonFields
  │     └── agent-sdk variant ── AgentSdkRunnerFields + PlannerCommonFields
  │                                     │
  ├── implementer: ImplementerConfigSchema ┤
  │     ├── cli variant ── CliRunnerFields     + GenerationCommonFields
  │     ├── api variant ── ApiRunnerFields     + GenerationCommonFields
  │     ├── shell variant ── ShellRunnerFields  + GenerationCommonFields
  │     ├── agent variant ── AgentRunnerFields  + GenerationCommonFields
  │     └── agent-sdk variant ── AgentSdkRunnerFields + GenerationCommonFields
  │                                     │
  ├── validation: { typecheck, lint, test, testCommand }
  ├── workflow: { autoApproveSpec, autoApprovePlan, maxRetries, commitStrategy, mode?, maxBudget? }
  ├── theme?: ThemeMode
  ├── shikiTheme?: ShikiTheme
  ├── sessions?: { scope? }
  └── escalation?: EscalationConfig

PlannerCommonFields ─┐
                     ├──→ Both override `model` based on role (required in GenerationCommonFields,
GenerationCommonFields ┘    overridden to optional in PlannerCommonFields)
```

The composition means: the field blocks are defined exactly once; each role picks them up by spreading. Adding a new field to `CliRunnerFields` automatically makes it available to both planner and implementer cli variants.
