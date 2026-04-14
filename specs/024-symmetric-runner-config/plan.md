# Implementation Plan: Symmetric Runner Config

**Branch**: `024-symmetric-runner-config` | **Date**: 2026-04-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/024-symmetric-runner-config/spec.md`

## Summary

Finish the work that `specs/023-config-schema-refactor` started. Today the planner schema has 4 discriminated-union variants but the implementer schema has 10, sharing a loose `tool: z.string()` across every variant; `apiBase` is optional where it should be required; `patchImplementerConfig` synthesizes invalid intermediate configs with empty-string fallbacks; `validation.ts:implementerCrossFieldErrors` polices constraints that the schema should encode; and the TUI picker has three smell functions in `config-transforms.ts` working around the shape.

This refactor collapses both roles to exactly **5 symmetric Runner kinds** (`cli | api | shell | agent | agent-sdk`), defined once via shared field blocks (`CliRunnerFields`, `ApiRunnerFields`, etc.) and composed into role-specific variants with shared `GenerationCommonFields` for model/contextLength/temperature/timeout. Illegal states become unrepresentable at the zod parse boundary; every constraint previously enforced by runtime checks moves into the schema. A new `version: 2` root marker gates auto-migration from v1. A new `createAgentPlanner` + shared `invokeCommandBasedRunner` primitive completes the cli/shell/agent symmetry on both roles. The umbrella type name becomes **Runner** (not "Backend") everywhere.

diptych is pre-deployment, so the refactor can be a clean break — lazy in-place migration at `loadConfig()` handles the one remaining class of legacy configs (contributor laptops with v1 files on disk).

## Technical Context

**Language/Version**: TypeScript 6.x, ESM only (`"type": "module"`), Node.js 22+
**Primary Dependencies**: `zod` 3.x (schema validation), `yaml` (YAML parsing), `vitest` 4.x (testing), `ink` 6.x (TUI / React 19), `commander` (CLI), `@anthropic-ai/claude-agent-sdk` (optional peer dep — isolated in `src/engine/agent-sdk.ts:loadSdk`)
**Storage**: `.diptych/config.yml` (user config, YAML), `.diptych/current/state.json` (workflow state, display strings only — no migration needed)
**Testing**: Vitest 4.x with colocated `*.test.ts` / `*.test.tsx` files next to implementations
**Target Platform**: macOS (primary), Linux (secondary); Node.js 22+
**Project Type**: Single project — CLI tool with TUI, rendered with Ink 6.x
**Performance Goals**: Config load time under 50ms for typical configs; picker commit under 10ms; no change to workflow runtime performance
**Constraints**: Zero test regressions (700+ tests must continue to pass); every commit in the execution sequence must leave `npm run typecheck` + `npm test` green; no changes to persisted `state.json` shape; no changes to `TuiEvent` union
**Scale/Scope**: ~45 source files touched across `src/core/`, `src/engine/`, `src/components/overlays/`, `src/stores/`, `src/hooks/`; 3 new schema files split from monolithic `schemas/config.ts`; 2 new runtime files (`runners/factory.ts`, `runners/command-based.ts`); 1 new planner backend (`planners/agent.ts`); 6 new test files (migration, build-runner, runner-config, runners/factory, runners/command-based, planners/agent)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Cost-Optimal Orchestration — ✅ PASS

This refactor touches how planner/implementer runners are configured, not how they are used. It does not add any Opus token consumption. It does not change which model runs which phase. The two-role separation stays intact. The refactor actually strengthens local-first capability by widening planner support to all API providers (including Ollama and LM Studio), which prior to this was restricted to cloud vendors. Cost-optimal orchestration is preserved and slightly strengthened.

### II. Spec-Driven Development — ✅ PASS

This refactor was specified via `/speckit.specify`, now plans via `/speckit.plan`, will generate tasks via `/speckit.tasks`, and will be analyzed via `/speckit.analyze` before any implementation. The user explicitly requested this workflow.

### III. Local-First Implementation — ✅ PASS

The refactor widens local support: after this change, users can point the planner at a local Ollama or LM Studio instance (previously restricted to cloud vendors). Implementer local-first is unchanged. Provider abstraction stays thin — the `api` runner kind still dispatches through the OpenAI-compatible API client; only the config shape and discriminator layout change.

### IV. Functional Purity — ✅ PASS

- Zero classes introduced. All new code is pure functions and discriminated-union types.
- ESM imports with `.js` extensions preserved.
- Error handling follows the existing boundary pattern: the config loader and overlay commit functions catch errors; internal helpers propagate.
- No unnecessary comments introduced. The spec and plan explicitly trimmed comments to only where logic is non-obvious.

### V. Validate Before Commit — ✅ PASS

The execution sequence below is ordered so every commit leaves `npm run typecheck` + `npm run lint` + `npm test` green. The atomic schema swap is a single commit but internally ordered so that pre-swap and post-swap states are both valid.

### VI. Identity & Anti-Goals — ✅ PASS

- diptych's two-role identity (planner + implementer) is unchanged. The `Runner` concept is a config-layer abstraction over how a role is run — it does not blur the boundary between roles at the runtime interface level. The `Planner` interface (6 methods) and `Implementer` interface (2 methods) stay separate and are explicitly out of scope.
- No generic multi-agent coordination introduced. The 5 runner kinds are concrete transports, not a "dynamic agent count".
- No tool-call support for implementer models added.
- No features that blur planner/implementer boundary added.
- File write delegation is already permitted (the existing `agent` implementer kind uses filesystem detection). Adding the symmetric `createAgentPlanner` extends the same permitted exception to the planner side — diptych still owns validation, retry, escalation, commits, and workflow.
- The refactor strengthens the "visible, understandable, satisfying" goal by eliminating cryptic runtime errors in favor of clear config-load errors.

**Gate result**: All six principles pass. No complexity tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/024-symmetric-runner-config/
├── plan.md              # This file
├── spec.md              # Feature specification (already written)
├── research.md          # Phase 0 output — architectural decisions + rationale
├── data-model.md        # Phase 1 output — Runner, PlannerConfig, ImplementerConfig, Config, migration shapes
├── contracts/           # Phase 1 output — internal "contracts" (schema shapes as source of truth)
│   ├── runner-fields.md       # Shared field blocks (one per kind)
│   ├── planner-config.md      # PlannerConfig discriminated union composition
│   ├── implementer-config.md  # ImplementerConfig discriminated union composition
│   ├── root-config.md         # Root ConfigSchema with version: 2
│   └── migration.md           # v1 → v2 migration rules
├── quickstart.md        # Phase 1 output — contributor guide for the new config module
├── checklists/
│   └── requirements.md  # Spec quality checklist (already written, all items pass)
└── tasks.md             # Phase 2 output (/speckit.tasks command — NOT created here)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── types/
│   │   ├── schemas/
│   │   │   ├── runner-fields.ts         # NEW — CliRunnerFields, ApiRunnerFields, ShellRunnerFields, AgentRunnerFields, AgentSdkRunnerFields, GenerationCommonFields
│   │   │   ├── planner-config.ts        # NEW — PlannerConfigSchema = z.discriminatedUnion(..., 5 variants composed from runner fields)
│   │   │   ├── implementer-config.ts    # NEW — ImplementerConfigSchema = z.discriminatedUnion(..., 5 variants), per-variant narrowing types
│   │   │   ├── config.ts                # REWRITTEN — minimal root ConfigSchema with version: 2, imports from the 3 new files
│   │   │   ├── enums.ts                 # MODIFIED — delete PROVIDER_IDS / PLANNER_TOOL_IDS / IMPLEMENTER_KINDS / PLANNER_KINDS / API_PLANNER_PROVIDER_IDS; add RUNNER_KINDS / CliToolIdSchema / CLOUD_API_PROVIDERS / LOCAL_API_PROVIDERS / KNOWN_API_PROVIDERS
│   │   │   ├── workflow.ts              # UNCHANGED
│   │   │   └── ...
│   │   ├── runner.ts                    # RENAMED from backends.ts, Backend interface → RunnerRuntime
│   │   └── config.ts                    # MODIFIED — re-exports
│   ├── config/
│   │   ├── loading.ts                   # MODIFIED — wire new migration, rewrite createDefaultConfig, simplify mergeWithDefaults
│   │   ├── migration.ts                 # REWRITTEN — migrateV1ToV2, migrateRunnerV1ToV2, inferLegacyKind
│   │   ├── validation.ts                # MODIFIED — delete implementerCrossFieldErrors, update implementerKeyInfo to use getRunnerApiKey/getRunnerDisplayName
│   │   ├── transforms.ts                # UNCHANGED (pure snake↔camel)
│   │   ├── runner-config.ts             # NEW — getRunnerDisplayName, getRunnerCommand, getRunnerApiKey
│   │   ├── build-runner.ts              # NEW — buildRunnerConfig(role, opts) unified constructor
│   │   ├── planner-config.ts            # DELETED — replaced by build-runner.ts
│   │   └── index.ts                     # MODIFIED — re-exports
│   └── providers/
│       ├── catalog.ts                   # MODIFIED — add KNOWN_API_BASE_URLS map + resolveDefaultApiBase()
│       └── pricing.ts                   # MODIFIED — add 'agent' entry to TOOL_PRICING
├── engine/
│   ├── runners/                         # NEW directory
│   │   ├── factory.ts                   # NEW — symmetric createPlanner + createImplementer via dispatchRunner, static imports
│   │   └── command-based.ts             # NEW — invokeCommandBasedRunner primitive (stdin/placeholder, extractsCode, detectChanges)
│   ├── planners/
│   │   ├── factory.ts                   # DELETED — replaced by runners/factory.ts
│   │   ├── agent.ts                     # NEW — createAgentPlanner (reads spec.md/plan.md/tasks.md written by command)
│   │   ├── shell.ts                     # MODIFIED — thin wrapper over invokeCommandBasedRunner(extractsCode: true)
│   │   ├── api.ts                       # MODIFIED — uses planner.provider, accepts any provider string
│   │   ├── cli.ts                       # MODIFIED — narrowed cli variant access
│   │   ├── claude-code.ts               # UNCHANGED
│   │   └── agent-sdk.ts                 # UNCHANGED (loads SDK inside)
│   ├── implementers/
│   │   ├── factory.ts                   # DELETED — replaced by runners/factory.ts
│   │   ├── cli.ts                       # RENAMED from tool.ts — createCliImplementer(config)
│   │   ├── shell.ts                     # MODIFIED — thin wrapper over invokeCommandBasedRunner(extractsCode: true)
│   │   ├── agent.ts                     # MODIFIED — thin wrapper over invokeCommandBasedRunner(extractsCode: false)
│   │   ├── api.ts                       # MODIFIED — impl.tool → impl.provider
│   │   ├── agent-sdk.ts                 # UNCHANGED
│   │   └── base.ts                      # UNCHANGED
│   ├── provider-clients/
│   │   └── client.ts                    # MODIFIED — impl.tool → impl.provider
│   ├── detection/
│   │   └── detect.ts                    # MODIFIED — minimalConfig() in v2 shape
│   ├── orchestrator/
│   │   ├── run.ts                       # MODIFIED — delete line 61 redundant check; use getRunnerDisplayName
│   │   ├── task-loop.ts                 # MODIFIED — use getRunnerDisplayName
│   │   ├── task-step.ts                 # MODIFIED — use getRunnerDisplayName
│   │   └── events.ts                    # MODIFIED — emit display names via getRunnerDisplayName
│   └── agent-sdk.ts                     # UNCHANGED
├── stores/
│   └── config.ts                        # MODIFIED — symmetric applyPlannerOverrides + applyImplementerOverrides, both delegate to buildRunnerConfig
├── components/
│   ├── home/
│   │   └── config-summary.tsx           # MODIFIED — use getRunnerDisplayName
│   └── overlays/
│       └── tool-model-picker/
│           ├── config-transforms.ts     # MODIFIED — delete toImplementerKind, delete implementerApiPatch, rewrite commits via buildRunnerConfig
│           ├── picker-catalog.ts        # MODIFIED — consume CLI_TOOL_IDS + KNOWN_API_PROVIDERS; simplify isCurrentConfig via getRunnerDisplayName
│           └── use-picker-catalog.ts    # MODIFIED — update imports
├── hooks/
│   └── use-cost-stats.ts                # MODIFIED — use getRunnerDisplayName
├── core/settings/
│   └── catalog.ts                       # MODIFIED — add readValue for implementer tool field
└── utils/
    └── runner-dispatch.ts               # RENAMED from backend-factory.ts — dispatchRunner helper (generic, sync, domain-agnostic)
```

**Structure Decision**: Single project — diptych is a CLI with TUI, all source under `src/`. No separate backend/frontend split. Tests are colocated with implementations (`foo.test.ts` next to `foo.ts`). This refactor fits the existing structure; no new top-level directories introduced. The one new directory (`src/engine/runners/`) groups the symmetric factory + shared command-based primitive.

## Complexity Tracking

No violations. Constitution Check passed on all six principles. No complexity entries required.
