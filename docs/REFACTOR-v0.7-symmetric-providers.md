# Refactor v0.7 — Symmetric Provider Architecture

## What Changed

Major architectural refactor: symmetric provider model, formal implementer abstraction, workflow modes, API-based planners, and Ink model picker. 60 files changed, ~2500 lines added, ~700 lines removed.

## Why

1. **Implementer was ad-hoc** — 2-method `ImplementerHandler` vs planner's 7-method `PlannerBackend`. No factory, no discovery, no pricing.
2. **Planner locked to CLI subprocesses** — couldn't use cheap API models (DeepSeek, Ollama) as planners.
3. **Single workflow mode** — 4 planner calls + 2 approval gates for every task, even "rename a variable".
4. **Readline picker** — no model discovery, no filtering, no provider grouping.
5. **Provider code duplicated** — detection only covered Ollama + LM Studio.

## Architecture Changes

### 1. Provider Registry (`src/engine/providers/`)

Shared provider layer used by both planners and implementers.

```
src/engine/providers/
  types.ts              — ProviderDef interface, ModelsResponse, ProviderOverrides
  registry.ts           — KNOWN_PROVIDERS, getProvider(), detectAvailableProviders()
  openai-compat.ts      — Shared factory for OpenAI-compatible endpoints
  ollama.ts             — Ollama provider (local, /api/tags, /api/show)
  lm-studio.ts          — LM Studio provider (local, /v1/models)
  deepseek.ts           — DeepSeek provider (6 lines, delegates to openai-compat)
  openrouter.ts         — OpenRouter provider (6 lines, delegates to openai-compat)
  generic.ts            — Custom endpoint provider (7 lines, delegates to openai-compat)
  index.ts              — Re-exports
```

Key: `createOpenAICompatProvider(name, baseURL, envKey, isLocal)` eliminates duplication across remote providers. `isAvailable()` is built into the factory. `getProvider(name, overrides?)` returns known providers or creates generic ones.

### 2. ImplementerBackend Abstraction (`src/engine/implementers/`)

Mirrors the PlannerBackend pattern.

```
src/engine/implementers/
  types.ts    — ImplementerBackend interface (name, implement, retry, isAvailable, listModels, getPricing)
  base.ts     — createImplementerBase() factory encoding shared pipeline
  factory.ts  — createImplementer(config) routing (api/shell/agent)
```

`createImplementerBase` encodes the duplicated pattern from all 3 backends:
1. Emit 'running' → 2. Read old content → 3. Invoke → 4. Extract/apply code → 5. Emit done/failed

Each backend (openai.ts, shell.ts, agent.ts) now only provides an `invoke` function + config. ~115 lines of duplicated code removed.

`implementer.ts` is a thin backward-compat wrapper that delegates to the factory.

### 3. Workflow Modes

Three modes instead of one:

| Mode | Planner Calls | Approval Gates | Use Case |
|------|:---:|:---:|---|
| `quick` | 1 | 0 | Small changes: "add endpoint", "fix bug" |
| `standard` (default) | 4 | 1 (spec only) | Medium features |
| `full` | 4 | 2 (spec + plan) | Large features, team handoffs |

- `WorkflowMode` type in `src/core/types/config.ts`
- `START_QUICK` state action skips directly to implementing
- `buildQuickPlanPrompt()` in `planning-prompts.ts` — single combined prompt
- `--mode quick|standard|full` CLI flag
- `/mode` slash command for runtime switching

### 4. API-Based Planner (`src/engine/planners/api.ts`)

Any OpenAI-compatible endpoint can now serve as planner. Uses `createPlannerBase` with `streamCompletion`.

```yaml
# Config: cheap planner + cheap implementer = $0
planner:
  provider: ollama
  model: qwen2.5-coder:32b
implementer:
  provider: ollama
  model: qwen2.5-coder:7b
```

Factory routing: if `config.planner.provider` is set → API planner. Otherwise → tool-based subprocess planner (existing behavior).

### 5. Ink Model Picker (`src/ui/`)

```
src/ui/
  picker-shell.tsx      — Generic PickerShell<T> component (shared layout)
  model-picker.tsx      — Model selection (grouped by provider: Local/Remote)
  planner-picker.tsx    — Planner selection (CLI tools + API providers)
  init-wizard.tsx       — Multi-step wizard: detect → pick planner → pick model
```

`PickerShell<T>` handles: title, filter input, scroll, visible slice, empty state, footer. Each picker only provides `renderRow` and data mapping.

### 6. Integration (`src/engine/orchestrator/`)

- `WorkflowContext` type bundles `{ projectDir, config, callbacks, planner, context }` — reduces options bag threading
- `runTaskLoop` accepts `WorkflowContext` instead of 5-6 individual parameters
- `/mode` and `/model` slash commands in `src/core/commands.ts`
- `errorStore.setMessage()` alias for informational messages (vs `setError` for actual errors)
- `markTask(task, status)` helper for explicit task mutation visibility

## Files Overview

### New files (22):
- `src/engine/providers/` — 8 files (types, registry, openai-compat, 4 providers, index)
- `src/engine/implementers/` — 3 files (types, base, factory)
- `src/engine/planners/api.ts`
- `src/engine/orchestrator/types.ts` (WorkflowContext)
- `src/ui/` — 4 files (picker-shell, model-picker, planner-picker, init-wizard)
- Tests colocated for all new files

### Modified files (~35):
- `src/core/types/config.ts` — WorkflowMode, planner.provider
- `src/core/state.ts` — START_QUICK transition
- `src/engine/implementers/openai.ts, shell.ts, agent.ts` — use createImplementerBase
- `src/engine/implementer.ts` — delegates to factory
- `src/engine/planners/factory.ts` — API planner routing
- `src/engine/planners/base.ts, types.ts` — quickPlan method
- `src/engine/orchestrator/planning.ts` — mode-aware planning
- `src/engine/orchestrator/index.ts, task-loop.ts` — WorkflowContext
- `src/engine/detection.ts` — delegates to provider registry
- `src/engine/providers.ts` — delegates to registry
- `src/cli/workflow.ts, src/cli.ts` — --mode flag
- `src/stores/config.ts, error.ts` — mode override, setMessage
- `src/core/commands.ts` — /mode, /model

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Shared factory for remote providers | DRY — deepseek/openrouter/generic were 37 lines each, now 6 |
| ImplementerBackend mirrors PlannerBackend | Symmetry — same factory pattern, same discovery |
| 3 modes (not 2) | Standard is the sweet spot — full planning with 1 approval gate |
| API planner via existing streaming infra | KISS — reuses streamCompletion, createPlannerBase |
| PickerShell generic component | DRY — both pickers shared 80% layout code |
| WorkflowContext object | Reduces 12-field options bags to 1 context param |
| Backward compat in implementer.ts | Non-breaking — orchestrator can migrate incrementally |

## What Was NOT Changed

- Planner subprocess backends (claude-code, codex, aider, etc.) — untouched
- Validation pipeline (tsc → lint → test) — untouched
- TUI conversation flow, event cards, diff views — untouched
- State persistence, resume support — untouched
- Escalation logic (hints → full) — untouched
