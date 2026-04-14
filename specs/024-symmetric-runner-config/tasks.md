---

description: "Task list for Symmetric Runner Config refactor (024)"
---

# Tasks: Symmetric Runner Config

**Input**: Design documents from `/specs/024-symmetric-runner-config/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Tests are included — the feature spec explicitly requires them in SC-009 (migration, build-runner, runner-config, runners/factory, command-based, planners/agent).

**Organization**: Tasks are grouped by user story. This is a refactor of an existing project, so "Setup" is minimal and "Foundational" is pure-additive prep that leaves the existing codebase green at every step. User Story 1 (P1) is the atomic schema swap that delivers invariant types. User Story 2 (P1) layers symmetry and the agent planner on top. Subsequent stories add migration, custom provider, and contributor DX verification.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1, US2, US3, US4, US5 — maps to user stories in spec.md (setup / foundational / polish have no story label)
- File paths are relative to the repo root unless absolute paths are shown

## Path Conventions

diptych is a single project with colocated tests:

- Source: `src/` with `core/`, `engine/`, `cli/`, `components/`, `screens/`, `stores/`, `hooks/`, `ui/`, `utils/` subdirs
- Tests: `foo.test.ts` / `foo.test.tsx` colocated next to `foo.ts`
- Specs: `specs/024-symmetric-runner-config/` (this feature's docs)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify prerequisites before touching code.

- [X] T001 Verify branch is `024-symmetric-runner-config`, `npm install` is clean, and baseline `npm run typecheck && npm run lint && npm test` is green. If any baseline check fails, STOP this refactor and report the baseline failure as a separate bug — do not attempt to fix unrelated issues inside the scope of 024.

**Checkpoint**: Baseline green, ready for foundational work.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Pure-additive prep. Every task here can land without breaking anything because it adds new code alongside the existing code. No consumers are switched yet — the old config schema still validates, the old factory still dispatches, but the new helpers exist and are tested in isolation.

**⚠️ CRITICAL**: All user-story work depends on these foundations. Every task must leave typecheck + tests green.

- [X] T002 [P] Add new enum exports to `src/core/types/schemas/enums.ts`: `RUNNER_KINDS`, `RunnerKindSchema`, `RunnerKind`, `CliToolIdSchema`, `CloudApiProvidersSchema`, `LocalApiProvidersSchema`, `KNOWN_API_PROVIDERS`, `CLOUD_API_PROVIDERS`, `LOCAL_API_PROVIDERS`. Do NOT delete old enums (`PROVIDER_IDS`, `PLANNER_TOOL_IDS`, `IMPLEMENTER_KINDS`, `PLANNER_KINDS`, `API_PLANNER_PROVIDER_IDS`) yet.
- [X] T003 [P] Add `KNOWN_API_BASE_URLS` constant and `resolveDefaultApiBase(provider: string): string | null` function to `src/core/providers/catalog.ts`. Include entries for `ollama`, `lm-studio`, `anthropic`, `openrouter`, `deepseek`.
- [X] T004 [P] Add `resolveDefaultApiBase` tests in `src/core/providers/catalog.test.ts` (create file if missing or extend existing): known providers return their base URL, unknown providers return `null`.
- [X] T005 [P] Create `src/core/types/schemas/runner-fields.ts` exporting `CliRunnerFields`, `ApiRunnerFields`, `ShellRunnerFields`, `AgentRunnerFields`, `AgentSdkRunnerFields`, `GenerationCommonFields` as raw zod shape objects per `contracts/runner-fields.md`. File is created but not yet imported by any consumer.
- [X] T006 [P] Create `src/core/config/runner-config.ts` exporting `RunnerConfig` type alias, `getRunnerDisplayName`, `getRunnerCommand`, `getRunnerApiKey` per `contracts/helpers.md`. The helpers use discriminated-union narrowing against the eventual new shape. For the transitional period, they may accept both old and new shapes via a union fallback that will be removed after the schema swap.
- [X] T007 [P] Create `src/core/config/runner-config.test.ts` with exhaustive cases for all 5 kinds of `getRunnerDisplayName`, `getRunnerCommand`, `getRunnerApiKey`. Verify discriminated-union narrowing works (compile-time check via `never` in default case).
- [X] T008 Create `src/engine/runners/` directory and add `src/engine/runners/command-based.ts` exporting `invokeCommandBasedRunner(opts, prompt, projectDir, onOutput?)` per `contracts/runner-factory.md`. Handle `extractsCode: true` via `spawnAndCollect`, `extractsCode: false` via `spawnWithShellFallback`, `{prompt}` placeholder substitution, `outputFormat` parsing, `detectChanges` hook.
- [X] T009 Create `src/engine/runners/command-based.test.ts` with cases: stdin mode (no placeholder), placeholder mode (with `{prompt}`), `extractsCode: true` parses stdout, `extractsCode: false` calls `detectChanges`, command-not-found error propagation.
- [X] T010 Refactor `src/engine/implementers/shell.ts` so `createShellImplementer` delegates its `invoke` callback to `invokeCommandBasedRunner({ extractsCode: true, command, args, outputFormat })`. Keep the signature `createShellImplementer(initialConfig: Config): Implementer` unchanged. All existing tests MUST still pass unchanged.
- [X] T011 Refactor `src/engine/implementers/agent.ts` so `createAgentImplementer` delegates its `invoke` callback to `invokeCommandBasedRunner({ extractsCode: false, detectChanges, command, args, outputFormat, supportPromptPlaceholder: true })`. All existing tests MUST still pass unchanged.
- [X] T012 Replace all direct reads of `config.implementer.tool` with `getRunnerDisplayName(config.implementer)` in: `src/engine/orchestrator/task-loop.ts`, `src/engine/orchestrator/task-step.ts`, `src/engine/orchestrator/run.ts`, `src/engine/orchestrator/events.ts`, `src/hooks/use-cost-stats.ts`, `src/components/home/config-summary.tsx`, `src/core/config/validation.ts`, `src/core/settings/catalog.ts`. Behaviour MUST be unchanged — the helper returns the same string against the old shape.
- [X] T013 Replace all direct reads of `config.planner.tool` (where the existing `getPlannerToolName` is not already used) with `getRunnerDisplayName(config.planner)` for consistency. Audit the same files as T012.

**Checkpoint**: Foundation ready. All new enums, helpers, and the command-based primitive exist and are tested. Existing consumers have been migrated to use `getRunnerDisplayName`. Old schema still active. Tests green.

---

## Phase 3: User Story 1 - Invalid configs rejected at load time (Priority: P1) 🎯 MVP

**Goal**: Make illegal config states unrepresentable at the type level. Replace the loose `tool: z.string()` shared field with per-variant fields, collapse the 6 near-duplicate CLI implementer schemas into one, require `apiBase` unconditionally on the API variant, delete post-load cross-field checks, and make every constraint live in the zod schema itself.

**Independent Test**: Construct a `config.yml` with each of the following invalid shapes and confirm the loader aborts at parse time with an actionable error naming the specific field: `{ kind: 'api', tool: 'claude-code' }`, `{ kind: 'api' }` without `apiBase`, `{ kind: 'shell' }` with empty `command`, `{ kind: 'cli', tool: 'unknown-tool' }`, config missing `kind` entirely.

### Tests for User Story 1

- [X] T014 [P] [US1] Create `src/core/types/schemas/planner-config.test.ts` with cases that confirm each of the 5 variants parses valid input and rejects invalid combinations (api kind with `tool` field → error, cli kind with `provider` field → error, api kind without `apiBase` → error, cli kind with unknown tool → error, missing `kind` → error). Use `PlannerConfigSchema.parse()` directly and assert on `ZodError.issues[].path`.
- [X] T015 [P] [US1] Create `src/core/types/schemas/implementer-config.test.ts` mirroring T014 for the implementer schema.
- [X] T016 [P] [US1] Create `src/core/config/build-runner.test.ts` with cases for `buildRunnerConfig('planner', opts)` and `buildRunnerConfig('implementer', opts)` covering: kind from explicit hint, kind inferred from shape (tool → cli, apiBase → api, command → shell), known provider with missing `apiBase` gets auto-filled, unknown provider with missing `apiBase` throws, missing required field throws.

### Implementation for User Story 1

- [X] T017 [P] [US1] Create `src/core/types/schemas/planner-config.ts` exporting `PlannerConfigSchema` as `z.discriminatedUnion('kind', [...])` composed from the 5 runner field blocks and a `PlannerCommonFields` block (with `model` optional). Also export `PlannerConfig` type and `PlannerRunnerKind` type. Per `contracts/planner-config.md`.
- [X] T018 [P] [US1] Create `src/core/types/schemas/implementer-config.ts` exporting `ImplementerConfigSchema` composed from the 5 runner field blocks and `GenerationCommonFields` directly (model required). Also export `ImplementerConfig`, `ImplementerRunnerKind`, and per-variant narrowing types (`CliImplementerConfig`, `ApiImplementerConfig`, etc.). Per `contracts/implementer-config.md`.
- [X] T019 [US1] Rewrite `src/core/types/schemas/config.ts` to be minimal — import `PlannerConfigSchema` from `./planner-config.js` and `ImplementerConfigSchema` from `./implementer-config.js`, add `version: z.literal(2)` at the top of `ConfigSchema`, keep the `validation` / `workflow` / `theme` / `shikiTheme` / `sessions` / `escalation` sections unchanged. Delete `ImplementerSharedFields`, all 10 old implementer variant schemas, `patchImplementerConfig`, `hasCommand`/`hasApiBase`/`hasApiKey` type guards, and the `CliToolImplementerConfig` alias. Per `contracts/root-config.md`.
- [X] T020 [US1] Create `src/core/config/build-runner.ts` exporting `Role` type, `BuildRunnerOpts` interface, and `buildRunnerConfig(role, opts): PlannerConfig | ImplementerConfig` per `contracts/helpers.md`. The decision tree must handle: explicit `kind`, kind-from-tool-id, kind-from-apiBase, kind-from-command, kind-from-existing, and error for missing info. For API kind, use `resolveDefaultApiBase` for auto-fill; throw on unknown provider without apiBase.
- [X] T021 [US1] Rewrite `src/core/config/migration.ts` with `migrateConfig`, `migrateV1ToV2`, `migrateRunnerV1ToV2`, `inferLegacyKind`, `pickCommonFields`, `pickArgsOutputFormat` helpers per `contracts/migration.md`. Handle legacy CLI-tool-as-kind, api-as-tool, missing-kind-inferred-from-shape, shell/agent with missing command (throw), agent-sdk. Error messages MUST name the role, the field, and the valid alternatives.
- [X] T022 [US1] Create `src/core/config/migration.test.ts` with at least 8 cases: legacy `kind: 'claude-code'` → `kind: 'cli', tool: 'claude-code'`, legacy `kind: 'api', tool: 'ollama'` → `kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1'`, legacy `kind: 'api', tool: 'my-custom'` without apiBase → throws, v1 without `kind` with `tool: 'claude-code'` → inferred cli, v1 `kind: 'shell', command: ''` → throws, v2 passthrough, non-object input → throws, `version: 3` → throws.
- [X] T023 [US1] Update `src/core/config/loading.ts`: rewrite `createDefaultConfig` to return a v2 shape (add `version: 2`, implementer `kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1'`), wire `migrateConfig` into the load pipeline before `validateConfig`, simplify `mergeWithDefaults` to use zod defaults where possible. Update `loading.test.ts` fixtures to the v2 shape.
- [X] T024 [US1] Update `src/core/config/validation.ts`: delete `implementerCrossFieldErrors` (lines 48-63 in the current file) and its call site (around line 135). Rewrite `implementerKeyInfo` to use `getRunnerApiKey` and `getRunnerDisplayName` instead of reading `impl.tool` directly. Update `validation.test.ts` to remove test cases specific to the deleted function; keep cases that now route through the zod schema.
- [X] T025 [US1] Delete `src/core/config/planner-config.ts` (old builder) — the functions `buildPlannerConfig`, `getPlannerToolName`, `getPlannerCommand`, `getPlannerModelName` are replaced by `buildRunnerConfig` and the `runner-config.ts` helpers. Update `src/core/config/index.ts` to re-export from the new files. Any remaining imports of the old symbols MUST be updated or will fail typecheck.
- [X] T026 [US1] Update `src/stores/config.ts`: rewrite `applyPlannerOverrides` to delegate to `buildRunnerConfig('planner', opts)`, and add a symmetric `applyImplementerOverrides` function delegating to `buildRunnerConfig('implementer', opts)`. Both MUST validate `tool`/`provider` strings (the old implementer path at lines 72-80 that passed overrides straight through without validation MUST be replaced). Update `stores/config.test.ts`.
- [X] T027 [US1] Update `src/engine/implementers/api.ts`: replace `impl.tool` with `impl.provider` at the streamCompletion call site (around line 42). Update any fixtures in colocated tests.
- [X] T028 [US1] Update `src/engine/provider-clients/client.ts`: replace `impl.tool` with `impl.provider` at the `getProvider` call site (around line 58). Update tests if any directly reference the field name.
- [X] T029 [US1] Update `src/engine/detection/detect.ts`: rewrite `minimalConfig()` to return a v2-shape config (`{ version: 2, planner, implementer, ... }`) with the new discriminated-union shapes. Ensure `minimalConfig()` passes `ConfigSchema.parse()`.
- [X] T030 [US1] Delete the redundant runtime check at `src/engine/orchestrator/run.ts:61` (`config.implementer.kind === 'shell' && !config.implementer.command`). Zod `.min(1)` on `command` subsumes it.

**Checkpoint**: User Story 1 is complete. The new schema is the source of truth. Illegal states are rejected at parse time. `implementerCrossFieldErrors` is gone. All existing tests pass plus the new schema/migration/build-runner tests. Users cannot construct a config file that loads but then fails at the first workflow step.

---

## Phase 4: User Story 2 - Same backend options for planner and implementer (Priority: P1)

**Goal**: Guarantee structural symmetry between planner and implementer. Add the new `createAgentPlanner` so the planner exposes the same 5 kinds as the implementer. Replace the two separate factory files with one symmetric `runners/factory.ts`. Ensure the TUI picker shows identical options for both roles.

**Independent Test**: (1) Set both `planner` and `implementer` in config.yml to the same Ollama API endpoint; run `diptych start "test"`; verify the planner successfully calls Ollama. (2) Configure a planner with `kind: 'agent'` pointing at a command that writes spec.md/plan.md/tasks.md; run `diptych start "test"`; verify the generated files are loaded as the planning output. (3) Open the TUI tool/model picker twice (once for planner, once for implementer) and confirm identical option lists.

### Tests for User Story 2

- [ ] T031 [P] [US2] Create `src/engine/runners/factory.test.ts` with cases for `createPlanner` and `createImplementer` across all 5 runner kinds × 2 roles = 10 dispatches. Verify each dispatch lands in the correct factory function and returns the correct runtime instance type.
- [ ] T032 [P] [US2] Create `src/engine/planners/agent.test.ts` with cases covering `createAgentPlanner`: invokes the command, reads generated spec.md/plan.md/tasks.md from disk, synthesizes a `PlanResult` with populated `phases[]`, throws if required files are missing after the command completes, handles command-not-found error path.
- [ ] T033 [P] [US2] Add symmetry assertions to `src/core/types/schemas/planner-config.test.ts` and `implementer-config.test.ts`: take a valid block for the cli/api/shell/agent/agent-sdk variants and verify that the same block (modulo `model` optionality on planner) parses under both schemas.

### Implementation for User Story 2

- [ ] T034 [US2] Rename `src/utils/backend-factory.ts` → `src/utils/runner-dispatch.ts`. Rename the exported function `createBackend` → `dispatchRunner` and update its signature to `dispatchRunner<T, A>(kind, factories, role, arg): T` (generic, sync, domain-agnostic). Update any colocated tests.
- [ ] T035 [US2] Rename `src/core/types/backends.ts` → `src/core/types/runner.ts`. Rename the `Backend` interface → `RunnerRuntime`. Update `src/core/types/index.ts` re-exports and all import sites.
- [ ] T036 [US2] Create `src/engine/runners/factory.ts` per `contracts/runner-factory.md`: static imports of all 10 factory functions (5 planner + 5 implementer), `PLANNER_FACTORIES` and `IMPLEMENTER_FACTORIES` registries typed as `Record<RunnerKind, ...>`, export `createPlanner(config): Planner` and `createImplementer(config): Implementer`, both delegating to `dispatchRunner`. The `cli` planner entry includes the secondary branch for `tool === 'claude-code'` → `createClaudeCodePlanner`, else → `createGenericCliPlanner`.
- [ ] T037 [US2] Create `src/engine/planners/agent.ts` exporting `createAgentPlanner(config: Config): Planner`. Implement the 6 `Planner` interface methods (plan / regenerate / escalateHint / escalateFull / quickPlan / review) by delegating to `invokeCommandBasedRunner({ extractsCode: false })` with appropriate prompts. After each invocation, read generated files from the project directory and synthesize the corresponding return value. Share as much logic as possible with `planners/shell.ts`.
- [ ] T038 [US2] Refactor `src/engine/planners/shell.ts` to delegate to `invokeCommandBasedRunner({ extractsCode: true })` for all 6 `Planner` methods (parity with the implementer shell refactor in T010). Keep its signature unchanged.
- [ ] T039 [US2] Update `src/engine/planners/api.ts`: use `planner.provider` instead of `planner.tool` at the `getProvider` / `streamCompletion` call sites. Accept any provider string (no enum restriction). Update any colocated tests.
- [ ] T040 [US2] Update `src/engine/planners/cli.ts`: narrow access via `config.planner.kind === 'cli'` guard, read `planner.tool` from the narrowed variant. No other logic changes.
- [ ] T041 [US2] Rename `src/engine/implementers/tool.ts` → `src/engine/implementers/cli.ts`. Rename the exported function `createToolImplementer(toolName, config)` → `createCliImplementer(config)` — the signature drops the separate `toolName` parameter because the factory now reads it from the narrowed cli variant. Update test fixtures.
- [ ] T042 [US2] Delete `src/engine/planners/factory.ts` and `src/engine/implementers/factory.ts`. Update all import sites (orchestrator, cli commands, tests) to import from `src/engine/runners/factory.ts` instead.
- [ ] T043 [US2] Update `src/components/overlays/tool-model-picker/config-transforms.ts`: delete `toImplementerKind` (silent 'api' fallback), delete `implementerApiPatch` (manual catalog lookup), rewrite `commitPlannerSelection`, `commitImplementerSelection`, `commitCustomCommand`, `commitCustomModel` to delegate to `buildRunnerConfig(role, opts)`. Both roles go through the same path — no role-specific branching.
- [ ] T044 [US2] Update `src/components/overlays/tool-model-picker/picker-catalog.ts`: consume `CLI_TOOL_IDS` + `KNOWN_API_PROVIDERS` (from the new enum split) to build the picker options list. Simplify `isCurrentConfig` to a single comparison using `getRunnerDisplayName`. Update `src/components/overlays/tool-model-picker/use-picker-catalog.ts` imports to match.
- [ ] T045 [US2] Update `src/core/providers/pricing.ts`: add an `agent: LOCAL_PRICING` entry to `TOOL_PRICING` (so agent-kind runners produce zero cost instead of falling through to a non-matching default). Update `pricing.test.ts` to cover the new entry.

**Checkpoint**: User Story 2 is complete. Planner and implementer accept the same 5 kinds. `createAgentPlanner` exists. The TUI picker shows identical options for both roles. A single `runners/factory.ts` replaces the two old factory files. Users can configure the same backend for both roles — verifiable by pointing both at Ollama.

---

## Phase 5: User Story 3 - Existing configs keep working via auto-migration (Priority: P2)

**Goal**: Comprehensive migration coverage. The migration logic was written in T021; this phase adds the edge-case tests and the integration tests that verify end-to-end round-tripping.

**Independent Test**: Drop a pre-refactor `config.yml` (with `kind: 'claude-code'` or `kind: 'api', tool: 'ollama'`) into a test project, run `diptych start "test"`, confirm it loads successfully. Trigger a save, inspect the file on disk, confirm it has been rewritten to v2 shape.

### Tests for User Story 3

- [ ] T046 [P] [US3] Extend `src/core/config/migration.test.ts` with edge cases: config with BOTH new-shape `provider` AND legacy `tool` in an API section → `provider` wins, legacy `kind: 'api'` with no `tool` and no `provider` → role defaults (implementer `ollama`, planner `anthropic`), legacy CLI-kind with extra unknown fields → fields dropped, config with user-supplied `apiBase` that differs from catalog → user value wins.
- [ ] T047 [P] [US3] Add an integration test `src/core/config/loading.test.ts::migration round-trip` that writes a v1 config to a temp directory, calls `loadConfig` (migration runs), calls `writeConfig` (should persist v2 shape), reads the file again, and asserts it now has `version: 2` and the migrated runner shapes.

### Implementation for User Story 3

- [ ] T048 [US3] Review `src/core/config/migration.ts` against the full edge case list in `contracts/migration.md` and fill any missing branches. Ensure every migration error message names the role, the field, and the alternative providers / kinds where applicable.
- [ ] T049 [US3] Update `src/cli/init-stores.ts` so the first `loadConfig` call catches migration-level errors and rethrows them with a prefix identifying the config file path and the underlying cause, so the CLI entry point at `src/cli.ts` can display the message via its existing user feedback path (not a stack trace). Test manually via `npm run dev -- start "test"` with a broken legacy config.

**Checkpoint**: User Story 3 is complete. Legacy configs load transparently. Unknown providers without `apiBase` produce actionable errors. First save after load persists the v2 shape.

---

## Phase 6: User Story 4 - Custom self-hosted providers still work (Priority: P2)

**Goal**: Verify that arbitrary (non-catalog) provider strings still work as long as `apiBase` is supplied. This capability already exists structurally in the new schema (since `provider` is `z.string().min(1)` not a closed enum), but we need explicit test coverage to prevent regression.

**Independent Test**: Configure an API implementer with a nonsense provider name and a real apiBase, run `diptych start "test"`, confirm the request reaches the endpoint. Configure the same minus `apiBase`, confirm a clear error.

### Tests for User Story 4

- [ ] T050 [P] [US4] Add cases to `src/core/types/schemas/implementer-config.test.ts`: `{ kind: 'api', provider: 'my-custom', apiBase: 'http://localhost:9000/v1', model: 'foo' }` parses successfully; the same minus `apiBase` produces a zod error at path `implementer.apiBase`. Mirror for `planner-config.test.ts`.
- [ ] T051 [P] [US4] Add cases to `src/core/config/build-runner.test.ts`: `buildRunnerConfig('implementer', { kind: 'api', tool: 'my-custom', apiBase: 'http://localhost:9000/v1', model: 'foo' })` returns a valid config; the same minus `apiBase` throws with a message naming the provider and listing `KNOWN_API_PROVIDERS`.

### Implementation for User Story 4

- [ ] T052 [US4] Verify `src/engine/provider-clients/registry.ts:getProvider` already handles unknown provider strings by falling back to generic OpenAI-compatible defaults (read the current implementation and confirm). If it does not, extend it to accept any provider as long as `apiBase` is supplied. Update its test file if behavior changes.

**Checkpoint**: User Story 4 is complete. Custom provider strings work when `apiBase` is supplied. Missing `apiBase` produces a clear error.

---

## Phase 7: User Story 5 - Contributors can add a new CLI tool by editing one list (Priority: P3)

**Goal**: Prove that the one-edit-adds-a-CLI-tool property holds. Document the procedure in the quickstart. No code change is required — the schema composition from Phase 3 already enables this.

**Independent Test**: Temporarily add `'test-cli-tool'` to `CLI_TOOL_IDS`, run `npm run typecheck`. Exactly the sites needing follow-up (display labels, known-model catalog entries) should surface as errors; no schema duplication should be required. Revert the temporary addition.

### Tests for User Story 5

- [ ] T053 [P] [US5] Add a guard test at `src/core/types/schemas/enums.test.ts` (create if missing) asserting that every entry in `CLI_TOOL_IDS` is a valid value for both the CLI planner variant and the CLI implementer variant — constructing `{ kind: 'cli', tool: <id>, model: 'test', contextLength: 8000, temperature: 0 }` and parsing it under both schemas must succeed for every id.

### Implementation for User Story 5

- [ ] T054 [US5] Verify `quickstart.md` "Add a new CLI tool" section still reads correctly against the final code (after all previous phases land). Update file paths or function names if they drifted.
- [ ] T055 [US5] Add a contributor-facing note at the top of `src/core/types/schemas/runner-fields.ts` (one short comment block, not per-field) explaining that this is the single source of truth for runner kind fields and that adding a new field here propagates to both roles.

**Checkpoint**: User Story 5 is complete. A contributor editing one list can add a CLI tool; the procedure is documented.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup, verification, and the final grep-zero checks promised in the plan.

- [ ] T056 [P] Run the full grep checklist from `plan.md` verification section and confirm zero matches for: `implementer\.tool`, `planner\.tool` (outside `runner-config.ts`), `kind ?? `, `kind === 'claude-code'|'codex'|'aider'|'copilot'|'opencode'|'kilo-code'` (outside runner-fields/migration), `implementerCrossFieldErrors`, `toImplementerKind`, `implementerApiPatch`. Fix any leftover hits.
- [ ] T057 [P] Delete legacy enum exports from `src/core/types/schemas/enums.ts` now that no consumer uses them: `PROVIDER_IDS`, `PLANNER_TOOL_IDS`, `PLANNER_KINDS`, `IMPLEMENTER_KINDS`, `API_PLANNER_PROVIDER_IDS`, `PlannerToolIdSchema`, `isPlannerToolId`, `isProviderId` (only if no remaining consumers — verify via typecheck). Keep `CLI_TOOL_IDS`, `OUTPUT_FORMATS`, the new `RUNNER_KINDS` family, and the new `CLOUD_API_PROVIDERS` / `LOCAL_API_PROVIDERS` / `KNOWN_API_PROVIDERS` exports.
- [ ] T058 [P] Rename any remaining `Backend` symbols that escaped the rename sweep. Grep for `\bBackend\b` across `src/` and rename to `Runner` / `RunnerRuntime` as appropriate. The only file where "backend" may remain is the optional peer dep name (`@anthropic-ai/claude-agent-sdk`) and comments referring to that package.
- [ ] T059 Update `CLAUDE.md` "Active Technologies" and "Project Structure" sections if the agent context script didn't fully capture the new file layout (schema files split, `runners/` subdir, `runner-config.ts`, `build-runner.ts`).
- [ ] T060 Update `docs/STORES.md` and any other in-repo docs that reference the old `planner-config.ts` / `backend-factory.ts` / `Backend` interface. Update to the new names.
- [ ] T061 Run the full verification checklist from `plan.md`: `npm run typecheck`, `npm run lint`, `npm test`, `npm run dev -- init`, `npm run dev -- start "test feature"`, `npm run dev -- resume`, migration smoke test with a legacy config.
- [ ] T062 Final end-to-end symmetry check: set `planner.kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1'` in config.yml (previously impossible because the planner API was restricted to cloud providers). Run `diptych start "smoke test"` and confirm the planner successfully calls Ollama.
- [ ] T063 [P] Verify FR-005 (all validation at load time). Grep `src/` for any remaining post-zod functions that take a parsed `Config` and return a list of errors. The only acceptable survivors are policy checks in `src/core/config/validation.ts` — `apiKeyErrors` (env-var presence) and `securityWarnings` (non-blocking hints). Confirm `implementerCrossFieldErrors`, `plannerCrossFieldErrors`, and any similarly-named helpers do not exist. Fix if any slipped through.

**Checkpoint**: All verification checks pass. Grep-zero for all flagged patterns. Refactor is complete.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — immediately.
- **Phase 2 (Foundational)**: Depends on Phase 1. Every task is additive and individually green, but T010/T011 depend on T008 (command-based primitive must exist before shell/agent wrappers use it). T012/T013 depend on T006 (helpers must exist before consumers switch to them).
- **Phase 3 (US1 MVP)**: Depends on Phase 2. The atomic schema swap replaces the old config-handling code. Must be completed as a unit because intermediate states (e.g., new schema + old migration) won't typecheck. All tests for US1 (T014-T016) can run in parallel before the implementation tasks (T017-T030).
- **Phase 4 (US2)**: Depends on Phase 3. Can start once US1 is green because the new schema shapes are the foundation for symmetry work.
- **Phase 5 (US3)**: Can start in parallel with Phase 4. Migration logic was written in T021 during Phase 3; Phase 5 just extends test coverage.
- **Phase 6 (US4)**: Can start in parallel with Phase 4/5. Custom provider capability exists after Phase 3; Phase 6 adds tests.
- **Phase 7 (US5)**: Can start in parallel with Phase 4/5/6 after Phase 3 lands. Contributor verification.
- **Phase 8 (Polish)**: Depends on Phases 3-7. The grep checks cannot pass until all renames have happened.

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2. No dependencies on other stories.
- **US2 (P1)**: Depends on US1 (the new schema shapes are the foundation for symmetry).
- **US3 (P2)**: Can start after US1 (migration logic lives in Phase 3, US3 extends tests and integration).
- **US4 (P2)**: Can start after US1 (custom provider capability is structural, US4 verifies).
- **US5 (P3)**: Can start after US1 (one-edit-adds-CLI-tool property is structural, US5 documents and guards).

### Parallel Opportunities

- **Phase 2 parallels**: T002, T003, T004, T005, T006, T007 can all run in parallel (different files).
- **Phase 3 test parallels**: T014, T015, T016 can all run in parallel (different test files).
- **Phase 3 schema parallels**: T017, T018 can run in parallel (independent new files). T019 depends on both.
- **Phase 4 test parallels**: T031, T032, T033 can all run in parallel.
- **Phase 5-7 overall**: Once Phase 3 is complete, US3/US4/US5 phases can run in parallel across developers.
- **Phase 8 grep/polish**: T056, T057, T058 can run in parallel.

---

## Parallel Example: Phase 2 Foundational

```bash
# Launch all additive foundational tasks in parallel:
Task: "T002 Add new enum exports to src/core/types/schemas/enums.ts"
Task: "T003 Add resolveDefaultApiBase to src/core/providers/catalog.ts"
Task: "T004 Add resolveDefaultApiBase tests"
Task: "T005 Create src/core/types/schemas/runner-fields.ts"
Task: "T006 Create src/core/config/runner-config.ts"
Task: "T007 Create src/core/config/runner-config.test.ts"
# Then sequential:
Task: "T008 Create src/engine/runners/command-based.ts" (depends on existing spawn helpers)
Task: "T009 Create command-based.test.ts" (depends on T008)
Task: "T010 Refactor implementers/shell.ts" (depends on T008)
Task: "T011 Refactor implementers/agent.ts" (depends on T008)
Task: "T012 Swap implementer.tool consumer reads" (depends on T006)
Task: "T013 Swap planner.tool consumer reads" (depends on T006)
```

## Parallel Example: Phase 3 User Story 1

```bash
# All tests first (different files):
Task: "T014 [US1] planner-config.test.ts"
Task: "T015 [US1] implementer-config.test.ts"
Task: "T016 [US1] build-runner.test.ts"

# New schema files (independent):
Task: "T017 [US1] schemas/planner-config.ts"
Task: "T018 [US1] schemas/implementer-config.ts"

# Then sequential downstream (each blocks the next):
Task: "T019 [US1] Rewrite root schemas/config.ts" (depends on T017, T018)
Task: "T020 [US1] Create build-runner.ts" (depends on T017, T018)
Task: "T021 [US1] Rewrite migration.ts" (depends on T017, T018, T020)
Task: "T022 [US1] migration.test.ts" (depends on T021)
# ... etc
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Complete Phase 1 (baseline verification).
2. Complete Phase 2 (foundational additive prep).
3. Complete Phase 3 (US1 atomic schema swap).
4. **STOP and VALIDATE**: `npm test` + manual smoke test confirming illegal configs are rejected at load time with actionable errors.
5. This is the MVP of the refactor — illegal states are unrepresentable.

### Incremental Delivery

1. Phases 1-3 → Illegal states unrepresentable. Tests green. MVP shippable.
2. Phase 4 (US2) → Symmetric planner/implementer + `createAgentPlanner`. Second shippable increment.
3. Phase 5 (US3) → Full migration coverage. Third increment.
4. Phase 6 (US4) → Custom provider verification. Fourth increment.
5. Phase 7 (US5) → Contributor DX guard test + docs. Fifth increment.
6. Phase 8 (Polish) → Final cleanup and grep-zero checks.

Every increment leaves `npm run typecheck` + `npm run lint` + `npm test` green.

### Sequential (Solo Developer)

Since this refactor will be implemented in a separate AI context by a single agent (per user instruction), sequential execution is the realistic path:

1. Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8.
2. Within each phase, run the parallelizable tasks first (the `[P]` ones in the task list), then the dependent tasks.
3. Leave every completed task as an unstaged working-tree change for the user to commit manually. Per constitution principle V and the project CLAUDE.md, the implementing agent MUST NOT run `git commit` / `git add` / `git stage`. The user reviews each task's diff and commits at their own cadence — typically one commit per task per the constitution's "each commit MUST correspond to one completed task" rule.

---

## Notes

- `[P]` tasks modify different files and have no dependencies on incomplete tasks.
- `[US#]` labels trace tasks to user stories from `spec.md`.
- Test tasks (T014-T016, T031-T033, T046-T047, T050-T051, T053) should be written before their corresponding implementation tasks per the story, though this is a refactor (not greenfield) so TDD is applied only where it sharpens the spec.
- Every commit MUST leave `npm run typecheck` + `npm test` green. The atomic schema swap (Phase 3) is the most sensitive — no commit mid-swap should be pushed.
- The project CLAUDE.md explicitly forbids `git commit` / `git add` / `git stage` from agent tools. The implementing agent MUST leave every change unstaged for the user to review and commit manually.
- File paths use the repo structure from `plan.md`. Any new files that should go in a new directory (`src/engine/runners/`) must create the directory in the same task that creates the first file.
