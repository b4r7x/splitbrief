# Contract: Root ConfigSchema

**File**: `src/core/types/schemas/config.ts` (REWRITTEN — minimal root only)

## Purpose

The top-level shape of `.diptych/config.yml`. Minimal wrapper around `PlannerConfigSchema` and `ImplementerConfigSchema` plus the non-runner sections (validation, workflow, theme, sessions, escalation).

## Exports

```ts
export const ConfigSchema: z.ZodObject<...>
export type Config = z.infer<typeof ConfigSchema>
export const EscalationConfigSchema: z.ZodObject<...>
```

## Shape

```ts
export const ConfigSchema = z.object({
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

export type Config = z.infer<typeof ConfigSchema>;
```

## Contract

### Version field

- `version` is a literal `2`. Any other value causes a parse error. v1 configs are detected before parse and routed through `migrateV1ToV2`.
- Future migrations (v2 → v3) can be added by updating this literal and the migration chain.

### Unchanged sections

`validation`, `workflow`, `theme`, `shikiTheme`, `sessions`, `escalation` are structurally unchanged from v1. No migration is needed for them.

### Parse pipeline

Called from `src/core/config/loading.ts:loadConfig`:

```text
YAML file on disk
  → readFileSync
  → YAML.parse  (untyped Record<string, unknown>)
  → fromYaml (snake_case → camelCase key transform)
  → migrateConfig (routes by version; v1 → migrateV1ToV2; v2 → pass-through)
  → ConfigSchema.parse (zod validation)
  → Config (fully typed, in-memory)
```

### Error surfacing

Parse errors are surfaced as `ZodError` with path-based messages like:
- `planner.apiBase: String must contain at least 1 character(s)`
- `implementer.kind: Invalid discriminator value. Expected 'cli' | 'api' | 'shell' | 'agent' | 'agent-sdk'`
- `planner.tool: Invalid enum value. Expected 'claude-code' | 'codex' | 'opencode' | 'aider' | 'copilot' | 'kilo-code', received 'unknown-tool'`

The loader wraps these into a user-facing error that includes the file path and the specific field.

## Consumers

- `src/core/config/loading.ts` — `loadConfig`, `writeConfig`, `createDefaultConfig`
- `src/stores/config.ts` — loads and holds `Config` in memory
- `src/engine/runners/factory.ts` — reads `config.planner` and `config.implementer`
- Everything else that receives `config: Config` via prop drilling or store access

## Deleted helpers (were in the old `config.ts`)

- `ImplementerSharedFields` object — replaced by per-variant composition
- All 10 old implementer variant schemas — replaced by 5 variants composed from runner fields
- `patchImplementerConfig` function — replaced by `buildRunnerConfig` in `src/core/config/build-runner.ts`
- `hasCommand` / `hasApiBase` / `hasApiKey` type guards — replaced by discriminated-union narrowing via `runner.kind ===` checks
- `CliToolImplementerConfig` alias (which was a lie: it aliased `ClaudeCodeImplementerConfig` as if it covered all 6 CLI tools)
