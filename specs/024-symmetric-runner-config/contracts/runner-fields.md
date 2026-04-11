# Contract: Runner Field Blocks

**File**: `src/core/types/schemas/runner-fields.ts` (NEW)

## Purpose

Export raw zod shape objects (not full schemas) representing each runner kind. These blocks are spread into role-specific discriminated unions by `planner-config.ts` and `implementer-config.ts`. Defining fields here once means adding a field flows automatically to both roles.

## Exports

```ts
export const CliRunnerFields
export const ApiRunnerFields
export const ShellRunnerFields
export const AgentRunnerFields
export const AgentSdkRunnerFields
export const GenerationCommonFields
```

## Contract

### `CliRunnerFields`

```ts
{
  kind: z.literal('cli'),
  tool: CliToolIdSchema,
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
}
```

**Invariants**:
- `kind` is the literal string `'cli'`. Zod-enforced.
- `tool` is one of `CLI_TOOL_IDS` (closed enum). A string not in the enum causes a parse error naming the invalid value.
- `args` and `outputFormat` are optional with no default.

**Imports required**: `{ z }` from `'zod'`, `{ CliToolIdSchema, OutputFormatSchema }` from `'./enums.js'`.

### `ApiRunnerFields`

```ts
{
  kind: z.literal('api'),
  provider: z.string().min(1),
  apiBase: z.string().min(1),
  apiKey: z.string().optional(),
}
```

**Invariants**:
- `kind` is the literal string `'api'`. Zod-enforced.
- `provider` is any non-empty string. No closed-enum constraint (preserves custom self-hosted endpoint support).
- `apiBase` is **unconditionally required** and non-empty. Migration auto-fills for known providers via `resolveDefaultApiBase`.
- `apiKey` is optional; runtime falls back to env vars (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, etc.) if absent.

**Not allowed fields** (zod `.strict()` behavior by default, or caught by discriminated-union matching):
- `tool` (that's for CLI variant)
- `command` (that's for shell/agent variants)

### `ShellRunnerFields`

```ts
{
  kind: z.literal('shell'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
}
```

**Invariants**:
- `kind` is `'shell'`. Zod-enforced.
- `command` is required and non-empty. No `?? ''` fallback anywhere in the codebase produces an empty string.
- `args` and `outputFormat` are optional.

**Runtime semantics** (not enforced by schema, but documented here):
- The `shell` kind is consumed by `invokeCommandBasedRunner({ extractsCode: true })`. The runtime spawns the command, sends the prompt to stdin, and parses stdout for code blocks.

### `AgentRunnerFields`

```ts
{
  kind: z.literal('agent'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  outputFormat: OutputFormatSchema.optional(),
}
```

**Invariants**: same as `ShellRunnerFields` structurally.

**Runtime semantics**:
- The `agent` kind is consumed by `invokeCommandBasedRunner({ extractsCode: false, detectChanges: ... })`. The runtime spawns the command, delivers the prompt via stdin or `{prompt}` placeholder substitution, and verifies the command wrote files to disk via filesystem detection.

### `AgentSdkRunnerFields`

```ts
{
  kind: z.literal('agent-sdk'),
  apiKey: z.string().optional(),
}
```

**Invariants**:
- `kind` is `'agent-sdk'`. Zod-enforced.
- `apiKey` is optional; runtime uses `ANTHROPIC_API_KEY` env var if absent.

**Runtime semantics**:
- Uses the optional peer dep `@anthropic-ai/claude-agent-sdk` via `loadSdk()` in `src/engine/agent-sdk.ts`. If the peer dep is not installed, `loadSdk()` throws an actionable error at invoke time.

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

**Invariants**:
- `model` is required and non-empty by default. Role-specific schemas MAY override to optional (the planner schema does this — see `contracts/planner-config.md`).
- `customModels` is optional; used by the TUI picker to show user-added models.
- `contextLength` is a positive integer; optional because some CLI tools manage context themselves.
- `temperature` is 0..2; optional.
- `timeout` is positive ms, max 600000 (10 min); optional.

## Consumer contract

Consumers of this file (the planner/implementer schema files) MUST:
- Spread these objects into their `z.object({ ... })` composition.
- NOT add duplicate `kind` fields.
- NOT redefine any field that's already in the spread (only overrides via subsequent spread are allowed — e.g., planner overrides `model` to optional).

## Change procedure

To add a new field to a runner kind:
1. Add it to the relevant `XxxRunnerFields` block.
2. Both planner and implementer variants pick it up automatically.
3. Update runtime consumers (e.g., factory functions that read the new field) — type checker will flag all sites.

To add a new runner kind:
1. Define a new `FooRunnerFields` block in this file.
2. Add `'foo'` to `RUNNER_KINDS` in `enums.ts`.
3. Add the new variant to both `PlannerConfigSchema` and `ImplementerConfigSchema`.
4. Add a factory function (`createFooPlanner`, `createFooImplementer`) in `engine/planners/foo.ts` and `engine/implementers/foo.ts`.
5. Register the factories in `src/engine/runners/factory.ts` — the type checker will flag the missing registry entries.
6. Add to `buildRunnerConfig` decision tree.
7. Update the picker catalog.
8. Add migration rule if the new kind replaces an old shape.
