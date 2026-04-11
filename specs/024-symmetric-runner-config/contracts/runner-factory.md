# Contract: Runner factory & command-based primitive

**Files**:
- `src/engine/runners/factory.ts` (NEW) — symmetric `createPlanner` / `createImplementer`
- `src/engine/runners/command-based.ts` (NEW) — `invokeCommandBasedRunner` primitive
- `src/utils/runner-dispatch.ts` (RENAMED from `backend-factory.ts`) — generic dispatcher

## Purpose

Produce runtime `Planner` and `Implementer` instances from parsed configs, dispatched symmetrically via a single generic helper. Factor out the spawn/parse plumbing shared between shell/agent kinds on both sides.

## `runner-dispatch.ts` exports

```ts
export function dispatchRunner<T, A>(
  kind: string,
  factories: Record<string, (arg: A) => T>,
  role: string,
  arg: A,
): T;
```

### Contract

- Fully generic — no domain imports. Lives in `src/utils/` where shared helpers live.
- Looks up `kind` in `factories`; throws with supported-list if unknown.
- Takes a single `arg` (typically the `Config` object) and passes it through to the matched factory.
- Replaces the old `createBackend` helper in `backend-factory.ts`.

```ts
export function dispatchRunner<T, A>(kind, factories, role, arg): T {
  const factory = factories[kind];
  if (!factory) {
    throw new Error(`Unknown ${role} kind: ${kind}. Supported: ${Object.keys(factories).join(', ')}`);
  }
  return factory(arg);
}
```

## `runners/factory.ts` exports

```ts
export function createPlanner(config: Config): Planner;
export function createImplementer(config: Config): Implementer;
```

### Contract

- **Static imports only** for all factory functions (`createClaudeCodePlanner`, `createApiPlanner`, etc.). No `await import(...)` inside the factory file — verified during planning that the optional peer dep `@anthropic-ai/claude-agent-sdk` is already isolated inside `src/engine/agent-sdk.ts:loadSdk()` one layer deeper.
- Registries defined at module scope (not per-call), so the factory object is created once at module load.
- Both functions dispatch through the shared `dispatchRunner` helper.

### Registries

```ts
const PLANNER_FACTORIES: Record<RunnerKind, (config: Config) => Planner> = {
  cli: (c) => {
    if (c.planner.kind !== 'cli') throw new Error('unreachable');
    return c.planner.tool === 'claude-code'
      ? createClaudeCodePlanner(c.planner.model)
      : createGenericCliPlanner(c.planner.tool, c.planner.model);
  },
  api:         createApiPlanner,
  shell:       createShellPlanner,
  agent:       createAgentPlanner,
  'agent-sdk': createAgentSdkPlanner,
};

const IMPLEMENTER_FACTORIES: Record<RunnerKind, (config: Config) => Implementer> = {
  cli:         createCliImplementer,
  api:         createApiImplementer,
  shell:       createShellImplementer,
  agent:       createAgentImplementer,
  'agent-sdk': createAgentSdkImplementer,
};

export function createPlanner(config: Config): Planner {
  return dispatchRunner(config.planner.kind, PLANNER_FACTORIES, 'planner', config);
}

export function createImplementer(config: Config): Implementer {
  return dispatchRunner(config.implementer.kind, IMPLEMENTER_FACTORIES, 'implementer', config);
}
```

### Type exhaustiveness

`Record<RunnerKind, ...>` forces both registries to have exactly 5 entries matching the `RUNNER_KINDS` enum. Adding a new kind anywhere fails compilation until both registries gain the new entry.

### Deleted files

- `src/engine/planners/factory.ts` — replaced
- `src/engine/implementers/factory.ts` — replaced

## `runners/command-based.ts` exports

```ts
export interface CommandBasedRunnerOpts {
  command: string;
  args?: string[];
  outputFormat?: OutputFormat;
  timeout?: number;
  extractsCode: boolean;
  detectChanges?: (projectDir: string) => Promise<{ changed: boolean; output: string }>;
  supportPromptPlaceholder?: boolean;
}

export async function invokeCommandBasedRunner(
  opts: CommandBasedRunnerOpts,
  prompt: string,
  projectDir: string,
  onOutput?: (text: string) => void,
): Promise<InvokeResult>;
```

### Contract

- Consumes command + prompt, returns an `InvokeResult` (`{ text, usage }`).
- Handles:
  - `{prompt}` placeholder substitution in args (if `supportPromptPlaceholder: true` and any arg contains `{prompt}`) — sends no stdin
  - Otherwise, sends prompt via stdin
  - Spawn via `spawnAndCollect` when `extractsCode: true` (structured output parsing)
  - Spawn via `spawnWithShellFallback` when `extractsCode: false` (agent-style, falls back to shell if command not found)
  - `outputFormat` parsing (text / stream-json / jsonl)
  - `CommandNotFoundError` handling — rethrown for the caller to decide
  - Optional `detectChanges` hook run after the command completes (when `extractsCode: false`)

### Consumers

After this primitive exists, these 4 files each shrink to a thin wrapper:

- `src/engine/planners/shell.ts` — calls `invokeCommandBasedRunner({ extractsCode: true })` for each planner method
- `src/engine/planners/agent.ts` — calls `invokeCommandBasedRunner({ extractsCode: false, detectChanges })` + reads generated `spec.md`/`plan.md`/`tasks.md` from disk
- `src/engine/implementers/shell.ts` — calls `invokeCommandBasedRunner({ extractsCode: true })` from `createImplementerBase`'s `invoke`
- `src/engine/implementers/agent.ts` — calls `invokeCommandBasedRunner({ extractsCode: false, detectChanges })` from `createImplementerBase`'s `invoke`

### Change procedure

To change spawn behavior for all 4 consumers at once, modify this file. The consumers auto-pick up the change.

## Relationship to `createImplementerBase`

`src/engine/implementers/base.ts:createImplementerBase` is unchanged. It takes `{ extractsCode, invoke, detectChanges? }` and returns an `Implementer`. The `invoke` callback is what changed: shell and agent implementer wrappers now call `invokeCommandBasedRunner` inside their `invoke`, instead of inlining spawn logic.
