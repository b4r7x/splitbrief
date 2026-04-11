# Contract: PlannerConfigSchema

**File**: `src/core/types/schemas/planner-config.ts` (NEW)

## Purpose

Compose the 5 runner variants into a single discriminated union representing all valid planner configurations. Export `PlannerConfigSchema` (for zod parse) and `PlannerConfig` (inferred TypeScript type).

## Exports

```ts
export const PlannerConfigSchema: z.ZodDiscriminatedUnion<'kind', [...]>
export type PlannerConfig = z.infer<typeof PlannerConfigSchema>
export type PlannerRunnerKind = PlannerConfig['kind']
```

## Composition

```ts
const PlannerCommonFields = {
  ...GenerationCommonFields,
  model: z.string().min(1).optional(),
};

const PlannerConfigSchema = z.discriminatedUnion('kind', [
  z.object({ ...CliRunnerFields,      ...PlannerCommonFields }),
  z.object({ ...ApiRunnerFields,      ...PlannerCommonFields }),
  z.object({ ...ShellRunnerFields,    ...PlannerCommonFields }),
  z.object({ ...AgentRunnerFields,    ...PlannerCommonFields }),
  z.object({ ...AgentSdkRunnerFields, ...PlannerCommonFields }),
]);
```

## Contract

### Variant count

Exactly 5. Matches `RUNNER_KINDS`. Any change to that list MUST update this file in lockstep.

### Common fields override

The planner variant overrides `model` to `.optional()` because some CLI planners (notably Claude Code and Codex) auto-select their default model. All other generation params (`contextLength`, `temperature`, `timeout`, `customModels`) are inherited from `GenerationCommonFields` as-is.

### Narrowing

Consumers (e.g., runtime planner factories) can use discriminated-union narrowing:

```ts
if (config.planner.kind === 'cli') {
  // config.planner.tool is typed as CliToolId (not string)
}
```

Or use `Extract<PlannerConfig, { kind: 'cli' }>` for per-variant type aliases when needed.

### Parse behavior

- `PlannerConfigSchema.parse(input)` returns a fully typed `PlannerConfig` or throws `ZodError` with actionable messages.
- Illegal inputs are caught at parse time:
  - Missing `kind` → error listing valid kinds
  - Wrong field per kind → error naming the invalid field
  - Missing required field (e.g., `apiBase` on api kind) → error at the field path
  - Unknown CLI tool name → error listing valid CLI tool IDs

### Relationship to `PlannerRunner` runtime interface

`PlannerConfigSchema` is a **config-layer** contract. The runtime `Planner` interface (in `src/engine/planners/types.ts`) with its 6 methods (plan / regenerate / escalateHint / escalateFull / quickPlan / review) is unchanged by this refactor. Config describes what the user picked; the factory (`createPlanner` in `runners/factory.ts`) produces a runtime `Planner` from a parsed config.

## Consumers

- `src/core/types/schemas/config.ts` imports `PlannerConfigSchema` and embeds it as `planner: PlannerConfigSchema` in the root `ConfigSchema`.
- `src/core/config/validation.ts` uses `PlannerConfig` (inferred type) in its signature and helpers.
- `src/stores/config.ts` reads `Config['planner']` and produces new values via `buildRunnerConfig('planner', opts)`.
- `src/engine/runners/factory.ts` reads `config.planner.kind` and dispatches to the matching factory function.
- `src/engine/planners/{cli,api,shell,agent,agent-sdk}.ts` each receive `Config` and narrow to their own variant via `config.planner.kind === 'xxx'` guards.
