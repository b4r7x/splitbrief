# P3: YOLO Mode — `--yolo` CLI flag + `/yolo` slash command

**Date:** 2026-04-30
**Status:** Ready for implementation
**Priority:** P3
**Scope:** Small, additive — no existing behavior changes

## Summary

Add explicit YOLO mode that disables all approval gates for a session. Two entry points:

1. `--yolo` CLI flag on `diptych start` — sets `approval.enabled: false` for the session
2. `/yolo` slash command — toggles YOLO mode on/off at runtime

The naming is deliberate: "yolo" communicates risk in a way `approval.enabled: false` in YAML does not.

## Why

- Claude Code has `--dangerously-skip-permissions` — explicit, per-session, intentional
- Diptych only has `approval.enabled: false` in config YAML — too neutral, too permanent
- Power users want a fast toggle during a run without editing YAML
- The name "yolo" is universally understood as "I accept all risk"

## Context: how approval currently works

`gateAction()` in `src/engine/orchestrator/tiered-approval.ts:285-290`:

```ts
if (config.approval?.enabled === false) {
  return { allow: true };
}
```

This is the single bypass point. YOLO mode uses the same mechanism: it sets `approval.enabled` to `false` on the runtime config, without persisting to disk.

---

## File changes

### 1. `src/core/types/config-options.ts` — add `yolo` to `WorkflowOpts`

```ts
// Add to WorkflowOpts interface:
yolo?: boolean;
```

**Exact change:**

```ts
// BEFORE (line 39-40):
  worktree?: string;
  detach?: boolean;

// AFTER:
  worktree?: string;
  detach?: boolean;
  yolo?: boolean;
```

---

### 2. `src/cli/options.ts` — add `--yolo` option

```ts
// Add after the --worktree option (line 24):
    .option('--yolo', 'Skip all approval gates for this session (auto-approve everything)', false);
```

**Full file after change:**

```ts
import { Command } from 'commander';

export function addWorkflowOptions(cmd: Command): Command {
  return cmd
    .option('--auto', 'Auto-approve spec and plan (alias for --approve none)')
    .option('--approve <level>', 'Approval gates: none, spec, plan, all, default (follows mode)')
    .option('--model <model>', 'Override implementer model (alias for --implementer-model)')
    .option('--provider <provider>', 'Override implementer provider (alias for --implementer)')
    .option('--planner <tool>', 'Planner tool (claude-code, codex, opencode, aider, copilot, kilo-code, agent-sdk, anthropic, openrouter, shell)')
    .option('--planner-model <model>', 'Planner model (for API planners)')
    .option('--planner-command <cmd>', 'Custom planner command (when --planner=shell)')
    .option('--implementer <provider>', 'Implementer provider (ollama, lm-studio, deepseek, openrouter, claude-code, codex, opencode, aider, copilot, kilo-code, shell)')
    .option('--implementer-model <model>', 'Implementer model')
    .option('--implementer-command <cmd>', 'Custom implementer command (when --implementer=shell)')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--no-fullscreen', 'Disable fullscreen alternate screen buffer')
    .option('--no-mouse', 'Disable mouse tracking')
    .option('--mode <mode>', 'Workflow mode: instant, quick, standard, or speckit (full=speckit alias)')
    .option('--budget <amount>', 'Maximum budget in dollars (e.g., 2.00)', parseFloat)
    .option('--planner-effort <level>', 'Planner effort hint: low, medium, high, xhigh. Dropped on unsupported backends.')
    .option('--allow-hooks', 'Trust hook config without prompting (use in CI)', false)
    .option('--json', 'Headless mode: emit each EngineEvent as NDJSON to stdout, skip TUI render', false)
    .option('--otel-exporter <name>', 'Bootstrap an OTel exporter (currently only "console"); requires otel.enabled in config')
    .option('--worktree [name]', 'run in a new linked git worktree (.trees/<name>)')
    .option('--yolo', 'Skip all approval gates for this session (auto-approve everything)', false);
}
```

---

### 3. `src/core/config/runtime/overrides.ts` — add `yolo` to `CLIOverrides` and `applyCLIOverrides`

**Add `yolo` field to `CLIOverrides`:**

```ts
export interface CLIOverrides {
  planner?: { tool?: string | undefined; model?: string | undefined; command?: string | undefined };
  implementer?: { tool?: string | undefined; model?: string | undefined; command?: string | undefined };
  contextLength?: number | undefined;
  autoApprove?: boolean | undefined;
  approve?: string | undefined;
  mode?: WorkflowMode | undefined;
  budget?: number | undefined;
  plannerEffort?: string | undefined;
  yolo?: boolean | undefined;
}
```

**Add yolo handling at the end of `applyCLIOverrides`, before `return next` (after the plannerEffort block, around line 149):**

```ts
  if (overrides.yolo) {
    next = {
      ...next,
      approval: { ...next.approval, enabled: false },
    };
  }
  return next;
```

---

### 4. `src/cli/commands/start.ts` — wire `--yolo` into `buildCLIOverrides`

**Change `buildCLIOverrides` (line 61-79):**

```ts
// BEFORE:
function buildCLIOverrides(opts: WorkflowOpts, mode: WorkflowOpts['mode']): CLIOverrides {
  return {
    planner: {
      tool: opts.planner,
      model: opts.plannerModel,
      command: opts.plannerCommand,
    },
    implementer: {
      tool: opts.implementer ?? opts.provider,
      model: opts.implementerModel ?? opts.model,
      command: opts.implementerCommand,
    },
    autoApprove: opts.auto,
    approve: opts.approve,
    mode,
    budget: opts.budget,
    plannerEffort: opts.plannerEffort,
  };
}

// AFTER:
function buildCLIOverrides(opts: WorkflowOpts, mode: WorkflowOpts['mode']): CLIOverrides {
  return {
    planner: {
      tool: opts.planner,
      model: opts.plannerModel,
      command: opts.plannerCommand,
    },
    implementer: {
      tool: opts.implementer ?? opts.provider,
      model: opts.implementerModel ?? opts.model,
      command: opts.implementerCommand,
    },
    autoApprove: opts.auto,
    approve: opts.approve,
    mode,
    budget: opts.budget,
    plannerEffort: opts.plannerEffort,
    yolo: opts.yolo,
  };
}
```

**Also wire for the non-detach interactive path.** In the `registerStartCommand` action handler, after stores are initialized (around line 173), apply yolo override if set. This is needed because the interactive path applies CLI overrides via `initStores` → `configStore.load(projectDir, overrides)` — but that flow goes through `buildCLIOverrides` only for the detach path. For the interactive path, `opts` are passed to `setupWorkflow` which calls `configStore.load`.

Check: does `setupWorkflow` call `configStore.load` with overrides from opts? Read `src/cli/setup.ts`:

If `setupWorkflow` already builds and applies CLI overrides, the `yolo` field propagates automatically because `buildCLIOverrides` includes it and `applyCLIOverrides` handles it. If `initStores` is the override entry point instead, verify that it passes overrides through.

**Key insight:** In the interactive path (line 173), `initStores(projectDir, opts)` handles loading. Read `src/cli/init-stores.ts` to see if it builds overrides from `opts`:

The `initStores` function builds CLI overrides from `opts` and calls `configStore.load(projectDir, overrides)`. Since we added `yolo` to both `WorkflowOpts` and `CLIOverrides`, and `initStores` maps opts to overrides, we need to ensure `initStores` maps `opts.yolo` → `overrides.yolo`.

**Change in `src/cli/init-stores.ts`** — add `yolo: opts.yolo` to the overrides object:

Look for where `CLIOverrides` is built from `opts` in `init-stores.ts` and add `yolo: opts.yolo` alongside the other fields.

---

### 5. `src/engine/events/types.ts` — add `approval_mode_changed` event

**Add to the `EngineEvent` union (near the other approval events, around line 99):**

```ts
  | { type: 'approval_mode_changed'; ts: number; mode: 'yolo' | 'normal' }
```

---

### 6. `/yolo` slash command — `src/core/slash-commands/catalog.ts`

**Add to `createCommands` array, before the `/quit` command (around line 416):**

```ts
    {
      kind: 'noarg',
      name: '/yolo',
      label: 'YOLO',
      description: 'Toggle approval gates off/on (skip all confirmations)',
      validScreens: ALL_SCREENS,
      handler: () => {
        const current = ctx.getApprovalEnabled();
        const next = !current;
        ctx.setApprovalEnabled(next);
        if (!next) {
          ctx.setFeedbackMessage('YOLO mode ON — all approval gates disabled');
        } else {
          ctx.setFeedbackMessage('YOLO mode OFF — approval gates restored');
        }
      },
    },
```

---

### 7. `src/core/slash-commands/types.ts` — add methods to `CommandContext`

**Add two methods:**

```ts
  getApprovalEnabled: () => boolean;
  setApprovalEnabled: (enabled: boolean) => void;
```

**Full addition after `clearApprovals` (line 42):**

```ts
export interface CommandContext {
  // ... existing methods ...
  clearApprovals: (scope?: 'session' | 'always' | 'all') => number;
  getApprovalEnabled: () => boolean;
  setApprovalEnabled: (enabled: boolean) => void;
  acceptRunSnapshot: () => Promise<AcceptRunSnapshotResult>;
  // ... rest ...
}
```

---

### 8. `src/core/slash-commands/context.ts` — implement the two new context methods

**Add after `clearApprovals` implementation (around line 104):**

```ts
    getApprovalEnabled: () => {
      const config = configStore.get().config;
      return config?.approval?.enabled !== false;
    },
    setApprovalEnabled: (enabled) => {
      const current = configStore.get().config;
      if (!current) return;
      configStore.setApprovalEnabled(enabled);
    },
```

---

### 9. `src/stores/project/config.ts` — add `setApprovalEnabled` method

**Add function before `__testReset` (around line 64):**

```ts
function setApprovalEnabled(enabled: boolean) {
  store.set(s => {
    if (!s.config) return s;
    const currentEnabled = s.config.approval?.enabled !== false;
    if (currentEnabled === enabled) return s;
    return {
      ...s,
      config: {
        ...s.config,
        approval: { ...s.config.approval, enabled },
      },
    };
  });
}
```

**Add to `configStore` export:**

```ts
export const configStore = { ...storeBase(store), load, save, useConfig, setContextLength, setApprovalEnabled, __testReset };
```

**Important:** `setApprovalEnabled` modifies the **in-memory** config only. It does NOT write to disk (`writeConfig`). The toggle is session-scoped by design — restarting diptych restores the on-disk config.

---

### 10. `src/cli/init-stores.ts` — ensure `yolo` propagates to overrides

Read this file to find how overrides are built and add `yolo: opts.yolo`. The exact location depends on the existing code — look for where `CLIOverrides` is constructed.

---

## Event emission

When `/yolo` toggles the mode, emit an `approval_mode_changed` event. This requires the context to have access to the event bus, which it currently doesn't (context is TUI-side, bus is engine-side).

**Two options:**

**Option A (recommended): Emit via the lifecycle store.** The `lifecycleStore` or a dedicated store can record the yolo state change, and the orchestrator's event sink picks it up. But this is indirect.

**Option B: Don't emit an event from the slash command.** The `gateAction` already handles `approval.enabled === false` silently. The slash command provides user feedback via `feedbackStore`. The NDJSON log already captures approval decisions (or lack thereof). Adding an event is nice for telemetry but not strictly necessary for correctness.

**Recommendation:** Skip event emission from the `/yolo` slash command in v1. The `feedbackStore` message provides user confirmation. If needed later, add `approval_mode_changed` as a store-driven event that the TUI sink picks up.

However, for the `--yolo` CLI flag path: emit the event during startup in the orchestrator init, after config is loaded and approval is disabled. This can be done in `src/engine/orchestrator/run/init.ts` — check if `config.approval?.enabled === false` and emit `{ type: 'approval_mode_changed', ts: Date.now(), mode: 'yolo' }`.

**Startup event (in `src/engine/orchestrator/run/init.ts` or equivalent init path):**

```ts
if (config.approval?.enabled === false) {
  bus.publish({ type: 'approval_mode_changed', ts: Date.now(), mode: 'yolo' });
}
```

---

## UX behavior

### `--yolo` at startup

```
$ diptych start --yolo "add login feature"
```

- TUI renders normally
- All `gateAction()` calls return `{ allow: true }` without prompting
- No visual indicator needed beyond the initial log (user chose this explicitly)

### `/yolo` at runtime

```
> /yolo
YOLO mode ON — all approval gates disabled

> /yolo
YOLO mode OFF — approval gates restored
```

- Feedback message appears for 3 seconds (standard `feedbackStore` behavior)
- Toggle is immediate — next `gateAction()` call respects the new state
- No confirmation prompt ("are you sure?") — the user typed `/yolo`, they know what they're doing

### Headless / `--json`

- `--yolo` works with `--json` — auto-approves everything in headless mode
- No NDJSON event emitted for the mode itself (the absence of `approval_prompted` events is the observable signal)

---

## Tests

### Test 1: CLI flag disables approval — `src/core/config/runtime/overrides.test.ts`

Add to the existing test file:

```ts
it('yolo override disables approval', () => {
  const config = makeMinimalConfig();
  const result = applyCLIOverrides(config, { yolo: true });
  expect(result.approval?.enabled).toBe(false);
});

it('yolo override preserves other approval fields', () => {
  const config = makeMinimalConfig({
    approval: {
      enabled: true,
      tiers: { destructive: 'confirm' },
      feedRejectionsToPlanner: true,
    },
  });
  const result = applyCLIOverrides(config, { yolo: true });
  expect(result.approval?.enabled).toBe(false);
  expect(result.approval?.tiers?.destructive).toBe('confirm');
  expect(result.approval?.feedRejectionsToPlanner).toBe(true);
});

it('non-yolo override does not change approval', () => {
  const config = makeMinimalConfig({ approval: { enabled: true } });
  const result = applyCLIOverrides(config, {});
  expect(result.approval?.enabled).toBe(true);
});
```

### Test 2: gateAction respects yolo (approval disabled) — `src/engine/orchestrator/tiered-approval.test.ts`

The existing test file should already cover `approval.enabled === false`. If not, add:

```ts
it('gateAction allows all when approval is disabled', async () => {
  const config = makeConfig({ approval: { enabled: false } });
  const decision = await gateAction({
    actionDescription: 'rm -rf /important',
    task: makeTask(),
    dependsOnFiles: [],
    projectDir: '/test',
    sessionId: 'test-session',
    phase: 'implementing',
    bus: createTestBus(),
    callbacks: {},
    config,
  });
  expect(decision.allow).toBe(true);
});
```

### Test 3: configStore.setApprovalEnabled toggle — `src/stores/project/config.test.ts`

```ts
it('setApprovalEnabled toggles in-memory config', () => {
  configStore.__testReset({
    config: makeMinimalConfig({ approval: { enabled: true } }),
    projectDir: '/test',
    overrides: {},
  });

  configStore.setApprovalEnabled(false);
  expect(configStore.get().config?.approval?.enabled).toBe(false);

  configStore.setApprovalEnabled(true);
  expect(configStore.get().config?.approval?.enabled).toBe(true);
});

it('setApprovalEnabled is a no-op when value matches', () => {
  const initial = makeMinimalConfig({ approval: { enabled: true } });
  configStore.__testReset({
    config: initial,
    projectDir: '/test',
    overrides: {},
  });
  const before = configStore.get().config;
  configStore.setApprovalEnabled(true);
  expect(configStore.get().config).toBe(before);
});

it('setApprovalEnabled does not write to disk', () => {
  const dir = tmpDir();
  writeMinimalConfig(dir);
  configStore.load(dir);
  configStore.setApprovalEnabled(false);

  // Reload from disk — should still be enabled (default)
  const { config: diskConfig } = loadConfig(dir);
  expect(diskConfig.approval?.enabled).not.toBe(false);
});
```

### Test 4: /yolo slash command toggles state — `src/core/slash-commands/catalog.test.ts`

```ts
it('/yolo toggles approval enabled state', () => {
  let approvalEnabled = true;
  const ctx = makeTestContext({
    getApprovalEnabled: () => approvalEnabled,
    setApprovalEnabled: (v: boolean) => { approvalEnabled = v; },
  });
  const commands = createCommands(ctx);
  const yolo = commands.find(c => c.name === '/yolo');
  expect(yolo).toBeDefined();

  // First toggle: disable
  yolo!.handler();
  expect(approvalEnabled).toBe(false);
  expect(ctx.lastFeedback).toBe('YOLO mode ON — all approval gates disabled');

  // Second toggle: re-enable
  yolo!.handler();
  expect(approvalEnabled).toBe(true);
  expect(ctx.lastFeedback).toBe('YOLO mode OFF — approval gates restored');
});
```

---

## Acceptance criteria

1. `diptych start --yolo "feature"` starts with all approval gates disabled
2. `diptych start --yolo --json "feature"` works in headless mode
3. `/yolo` typed in the TUI toggles approval off → on → off
4. `/yolo` shows feedback message confirming the toggle
5. Toggling with `/yolo` does NOT persist to disk — restart restores config defaults
6. `--yolo` combined with `--auto` does not conflict (both disable gates, yolo is additive)
7. `--yolo` combined with `--detach` works (server respects the flag)
8. All existing approval tests continue to pass
9. `npm run test-ci` passes (typecheck + lint + test)

---

## Files touched (summary)

| File | Change |
|---|---|
| `src/core/types/config-options.ts` | Add `yolo?: boolean` to `WorkflowOpts` |
| `src/cli/options.ts` | Add `--yolo` option |
| `src/core/config/runtime/overrides.ts` | Add `yolo` to `CLIOverrides`, handle in `applyCLIOverrides` |
| `src/cli/commands/start.ts` | Wire `opts.yolo` into `buildCLIOverrides` |
| `src/cli/init-stores.ts` | Wire `opts.yolo` into overrides for interactive path |
| `src/engine/events/types.ts` | Add `approval_mode_changed` event variant |
| `src/core/slash-commands/catalog.ts` | Add `/yolo` command |
| `src/core/slash-commands/types.ts` | Add `getApprovalEnabled` + `setApprovalEnabled` to `CommandContext` |
| `src/core/slash-commands/context.ts` | Implement the two new methods |
| `src/stores/project/config.ts` | Add `setApprovalEnabled` method |
| `src/engine/orchestrator/run/init.ts` | Emit `approval_mode_changed` on startup if yolo |
| `src/core/config/runtime/overrides.test.ts` | Add yolo override tests |
| `src/stores/project/config.test.ts` | Add setApprovalEnabled tests |
| `src/core/slash-commands/catalog.test.ts` | Add /yolo toggle test |

---

## Non-goals

- No persistent "yolo mode" in config — this is always session-scoped
- No special TUI indicator (status bar badge) — v1 uses feedback message only
- No confirmation prompt on `/yolo` — the name IS the confirmation
- No interaction with the planner (yolo is not fed back as context)
