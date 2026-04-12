# Contract: ImplementerConfigSchema

**File**: `src/core/types/schemas/implementer-config.ts` (NEW)

## Purpose

Compose the 5 runner variants into a single discriminated union representing all valid implementer configurations. Export `ImplementerConfigSchema` (for zod parse), `ImplementerConfig` (inferred TypeScript type), and per-variant narrowing types.

## Exports

```ts
export const ImplementerConfigSchema: z.ZodDiscriminatedUnion<'kind', [...]>
export type ImplementerConfig = z.infer<typeof ImplementerConfigSchema>
export type ImplementerRunnerKind = ImplementerConfig['kind']
export type CliImplementerConfig
export type ApiImplementerConfig
export type ShellImplementerConfig
export type AgentImplementerConfig
export type AgentSdkImplementerConfig
```

## Composition

```ts
const ImplementerConfigSchema = z.discriminatedUnion('kind', [
  z.object({ ...CliRunnerFields,      ...GenerationCommonFields }),
  z.object({ ...ApiRunnerFields,      ...GenerationCommonFields }),
  z.object({ ...ShellRunnerFields,    ...GenerationCommonFields }),
  z.object({ ...AgentRunnerFields,    ...GenerationCommonFields }),
  z.object({ ...AgentSdkRunnerFields, ...GenerationCommonFields }),
]);

export type CliImplementerConfig = Extract<ImplementerConfig, { kind: 'cli' }>;
export type ApiImplementerConfig = Extract<ImplementerConfig, { kind: 'api' }>;
export type ShellImplementerConfig = Extract<ImplementerConfig, { kind: 'shell' }>;
export type AgentImplementerConfig = Extract<ImplementerConfig, { kind: 'agent' }>;
export type AgentSdkImplementerConfig = Extract<ImplementerConfig, { kind: 'agent-sdk' }>;
```

## Contract

### Variant count

Exactly 5, matching `PlannerConfigSchema`. The two schemas MUST stay symmetric — any variant added to one MUST be added to the other.

### Common fields (no override)

Unlike planner, the implementer uses `GenerationCommonFields` directly. `model` is required (`.min(1)` at the field block level). Local models need an explicit model identifier to load.

### Parse behavior

Identical to `PlannerConfigSchema`. Illegal inputs are caught at parse time with actionable messages.

### Symmetry guarantee

The fact that both `PlannerConfigSchema` and `ImplementerConfigSchema` compose the same 5 runner fields means:
- Any YAML block that validates under `planner:` also validates under `implementer:` (modulo `model` being required for the implementer).
- Adding a field to a runner block (e.g., `CliRunnerFields`) propagates to both sides.
- Changing a field's type in a runner block updates both sides.

Automated tests in Phase 1 verify this symmetry by parsing identical blocks under both roles.

## Consumers

- `src/core/types/schemas/config.ts` embeds as `implementer: ImplementerConfigSchema`.
- `src/core/config/validation.ts` uses `ImplementerConfig` in `implementerKeyInfo` and related helpers.
- `src/stores/config.ts` produces new values via `buildRunnerConfig('implementer', opts)`.
- `src/engine/runners/factory.ts` reads `config.implementer.kind` and dispatches.
- `src/engine/implementers/{cli,api,shell,agent,agent-sdk}.ts` each narrow to their variant.
- `src/core/providers/pricing.ts` reads `config.implementer` via `getRunnerDisplayName` for cost calculation.

## Relationship to `ImplementerBase`

`src/engine/implementers/base.ts:createImplementerBase` is unchanged. It still takes `{ extractsCode, invoke, detectChanges? }` and produces an `Implementer`. The difference is that the `shell` and `agent` wrappers below it now delegate to `invokeCommandBasedRunner` instead of duplicating spawn plumbing.
