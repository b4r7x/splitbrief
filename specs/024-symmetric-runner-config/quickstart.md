# Quickstart — Symmetric Runner Config

A contributor's guide to the new runner config system after this refactor lands.

## What "runner" means

A **runner** is "the thing that runs an AI call". Five kinds:

| Kind | Transport | Identifier field | Runtime behavior |
|---|---|---|---|
| `cli` | subprocess of a known CLI tool | `tool: CliToolId` (enum) | Spawn CLI tool, parse stream-json / stdout |
| `api` | OpenAI-compatible HTTP endpoint | `provider: string` + required `apiBase` | HTTP streaming via `openai` SDK |
| `shell` | arbitrary user command | `command: string` | Spawn command, send prompt to stdin, parse stdout for code blocks |
| `agent` | arbitrary user command | `command: string` | Spawn command, let it write files to disk, detect changes |
| `agent-sdk` | Anthropic Agent SDK library call | (none — SDK configures itself) | Programmatic; loads optional peer dep on first use |

Both the **planner** (spec/plan/tasks generation) and the **implementer** (per-task code generation) accept all 5 kinds. The TypeScript types for the two sides are composed from the same 5 field blocks, so they're guaranteed to stay symmetric.

## Where things live

### Schema files

```text
src/core/types/schemas/
├── runner-fields.ts       # CliRunnerFields, ApiRunnerFields, ShellRunnerFields,
│                          # AgentRunnerFields, AgentSdkRunnerFields, GenerationCommonFields
├── planner-config.ts      # PlannerConfigSchema (5 variants composed from runner fields)
├── implementer-config.ts  # ImplementerConfigSchema (5 variants composed from runner fields)
└── config.ts              # Root ConfigSchema with version: 2
```

### Helpers

```text
src/core/config/
├── runner-config.ts       # getRunnerDisplayName, getRunnerCommand, getRunnerApiKey
├── build-runner.ts        # buildRunnerConfig(role, opts)
├── loading.ts             # loadConfig, writeConfig, createDefaultConfig
├── migration.ts           # migrateConfig (v1 → v2)
└── validation.ts          # apiKeyErrors, securityWarnings, implementerKeyInfo
```

### Runtime

```text
src/engine/runners/
├── factory.ts             # createPlanner, createImplementer (symmetric, static imports)
└── command-based.ts       # invokeCommandBasedRunner (shared spawn primitive for shell/agent)

src/engine/planners/
├── cli.ts                 # Generic CLI planner (fallback to claude-code for claude-code CLI)
├── claude-code.ts         # Special-case Claude Code CLI planner (stream-json + session chaining)
├── api.ts                 # API planner (any OpenAI-compatible endpoint)
├── shell.ts               # Shell planner (thin wrapper over invokeCommandBasedRunner)
├── agent.ts               # NEW — Agent planner (command writes spec/plan/tasks files)
└── agent-sdk.ts           # Anthropic Agent SDK planner

src/engine/implementers/
├── cli.ts                 # Generic CLI implementer (was tool.ts, now narrowed by kind)
├── api.ts                 # API implementer (uses impl.provider, not impl.tool)
├── shell.ts               # Thin wrapper over invokeCommandBasedRunner(extractsCode: true)
├── agent.ts               # Thin wrapper over invokeCommandBasedRunner(extractsCode: false)
└── agent-sdk.ts           # Anthropic Agent SDK implementer
```

## Common tasks

### Add a new CLI tool (e.g., `mycoder`)

One edit only:

1. In `src/core/types/schemas/enums.ts`, add `'mycoder'` to `CLI_TOOL_IDS`:

   ```ts
   export const CLI_TOOL_IDS = ['claude-code', 'codex', 'opencode', 'aider', 'copilot', 'kilo-code', 'mycoder'] as const;
   ```

2. Run `npm run typecheck`. The compiler will flag incidental consumers (e.g., display labels, known-model lists). Fix those.

3. The TUI picker picks up the new tool automatically because it iterates `CLI_TOOL_IDS`.

4. No schema variant changes, no factory registry edits, no migration updates.

### Add a new API provider (e.g., `mistral`)

One edit only:

1. In `src/core/providers/catalog.ts`, add an entry to `KNOWN_API_BASE_URLS`:

   ```ts
   const KNOWN_API_BASE_URLS: Record<string, string> = {
     ...,
     mistral: 'https://api.mistral.ai/v1',
   };
   ```

2. Add `'mistral'` to `CLOUD_API_PROVIDERS` in `enums.ts` if you want the picker to surface it.

3. Users can now write `kind: 'api', provider: 'mistral'` in their config without specifying `apiBase` — migration and default config will auto-fill it.

### Read the "currently selected backend" in a component or hook

Do NOT read `config.planner.tool` or `config.implementer.tool` directly — those fields don't exist on all variants.

```ts
import { getRunnerDisplayName } from '../core/config/runner-config.js';

const implementerName = getRunnerDisplayName(config.implementer); // 'claude-code' | 'ollama' | 'shell' | etc.
```

### Change backend from CLI overrides or picker UI

Do NOT construct a config object manually — you might end up with an invalid shape. Use the shared constructor:

```ts
import { buildRunnerConfig } from '../core/config/build-runner.js';

// From a CLI flag override
const newPlanner = buildRunnerConfig('planner', {
  tool: 'aider',             // user typed --planner-tool=aider
  model: 'opus-4',           // user typed --planner-model=opus-4
  existing: config.planner,  // keep previously set fields we're not overriding
});

// From a picker commit
const newImplementer = buildRunnerConfig('implementer', {
  kind: 'api',
  tool: 'ollama',            // for api kind, tool is the provider name (BuildRunnerOpts has no provider field)
  model: 'qwen2.5:7b',
  existing: config.implementer,
});
```

`buildRunnerConfig` guarantees the result is valid. If it can't construct a valid config (e.g., missing required field), it throws with an actionable error.

### Run a user-defined command as a shell/agent runner

On the implementer side, this already works via the existing `shell` and `agent` kinds. After this refactor, both kinds use a shared primitive (`invokeCommandBasedRunner`), so adding a feature (e.g., environment variable support) happens in one place:

```ts
// src/engine/runners/command-based.ts
export async function invokeCommandBasedRunner(opts, prompt, projectDir, onOutput) {
  // ... spawn logic ...
}
```

Both `implementers/shell.ts` and `implementers/agent.ts` call this. The planner side works the same way via `planners/shell.ts` and `planners/agent.ts`.

### Migrate a pre-refactor config

You don't. The migration is automatic:

```bash
$ diptych start "my feature"
# If config.yml is v1, it's silently rewritten to v2 shape on first save.
```

If a legacy config references an unknown API provider without `apiBase`, the tool aborts with a clear error naming the provider and listing known providers. Supply `apiBase` explicitly and try again.

### Smoke-test the refactor end-to-end

```bash
npm run typecheck
npm run lint
npm test
npm run dev -- init                           # creates a fresh v2 config
npm run dev -- start "test feature"           # runs full workflow
npm run dev -- resume                         # round-trips through state.json
```

## Illegal states you cannot construct

These are all caught at config load time with actionable error messages:

- `{ kind: 'api', tool: 'claude-code' }` — api variant has no `tool` field
- `{ kind: 'cli', provider: 'anthropic' }` — cli variant has no `provider` field
- `{ kind: 'api', provider: 'my-custom' }` without `apiBase` — custom providers require explicit base URL
- `{ kind: 'shell' }` without `command` — shell runners require a command
- `{ kind: 'cli', tool: 'unknown-tool' }` — cli tool must be in `CLI_TOOL_IDS`
- `{ /* missing kind */ }` — the discriminant is required

You cannot write code that produces these states either — the TypeScript types reject them at compile time.

## What NOT to do

- Don't add post-load validation functions. If you find yourself writing `if (config.implementer.kind === 'x' && !config.implementer.y)`, the schema is probably wrong — tighten the schema instead.
- Don't re-introduce a shared `tool: z.string()` field. Each variant has its own identifier field.
- Don't use `await import()` in `src/engine/runners/factory.ts` — use static imports. The only legitimate dynamic import in the codebase is `loadSdk()` in `src/engine/agent-sdk.ts` for the optional peer dep.
- Don't add silent kind defaults (`kind ?? 'api'`). A missing kind is a hard error.
- Don't read `config.planner.tool` or `config.implementer.tool` directly — use `getRunnerDisplayName`.
- Don't call the shared concept "Backend". It's called "Runner" throughout.
