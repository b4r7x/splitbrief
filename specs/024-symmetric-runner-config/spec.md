# Feature Specification: Symmetric Runner Config

**Feature Branch**: `024-symmetric-runner-config`
**Created**: 2026-04-11
**Status**: Draft
**Input**: User description: "Symmetric Runner Config Refactor — complete the work of specs/023-config-schema-refactor by making illegal states unrepresentable at the type level, eliminating runtime cleanup code, and guaranteeing planner/implementer expose the same 5 runner kinds."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Invalid configs rejected at load time (Priority: P1)

A tiny-spec user edits `.tiny-spec/config.yml` to change which backend the implementer uses. They accidentally mix two incompatible fields — for example, they declare the backend kind as an API endpoint but leave in a field that only makes sense for a CLI tool. Today this config passes loading and then fails at the first workflow step with a confusing runtime error (`Unknown provider: claude-code`). After this change, the config loader MUST catch the contradiction immediately, name the specific field that is wrong, and refuse to start the workflow.

**Why this priority**: This is the core user-facing pain the refactor addresses. Today the config system has hidden invariants users discover only when something breaks mid-workflow. Fixing this alone delivers most of the value: every failure moves from "cryptic runtime error after 30 seconds" to "clear error at config load, before anything runs".

**Independent Test**: Create a `config.yml` with an illegal field combination (e.g., implementer kind set to API plus a field that only makes sense for a CLI tool). Run `tiny-spec start "test"`. The tool MUST abort at the config loading step with an error that names the incompatible field and explains the expected shape. Do this for at least 5 categories of illegal combinations (wrong field per kind, empty required field, missing discriminant, unknown CLI tool name, missing required API base URL).

**Acceptance Scenarios**:

1. **Given** a config with `implementer.kind = api` and a `tool: claude-code` field, **When** the user runs any `tiny-spec` command, **Then** the tool exits immediately with a message naming the field `tool` as invalid for the API kind and referring the user to the correct field (`provider`).
2. **Given** a config with `implementer.kind = api` but no `apiBase` field and no provider name in the known-provider catalog, **When** the user runs any `tiny-spec` command, **Then** the tool exits with a message stating that `apiBase` is required for API runners and listing the known providers whose base URL would have been auto-filled.
3. **Given** a config with `planner.kind = shell` and an empty `command`, **When** the user runs any `tiny-spec` command, **Then** the tool exits with a message saying the shell command is empty.
4. **Given** a config with `implementer.kind = cli` and `tool: made-up-tool`, **When** the user runs any `tiny-spec` command, **Then** the tool exits with a message listing the valid CLI tool names.
5. **Given** a config missing the `kind` field entirely on either planner or implementer, **When** the user runs any `tiny-spec` command, **Then** the tool exits with a message explaining that `kind` is required and listing the 5 valid values.

---

### User Story 2 - Same backend options for planner and implementer (Priority: P1)

A tiny-spec user wants to run both the planner and the implementer against the same local Ollama instance to minimize cost entirely. Today they cannot — the planner rejects local-only providers because its API is restricted to cloud vendors, and the file-writing agent kind doesn't exist on the planner side at all. After this change, any backend choice valid on one role MUST also be valid on the other, with the same field shape.

**Why this priority**: This is the second user-visible pain. Users have told us they want to mix and match backends freely, not discover "this option only works for implementer". It also follows structurally from the previous story — once the config types are tight, symmetry becomes a natural consequence.

**Independent Test**: Configure both `planner` and `implementer` to point at the same Ollama instance (same kind, same provider, same apiBase, same model). Run `tiny-spec start "test feature"`. The planner MUST successfully call Ollama to generate spec/plan/tasks. Additionally, configure the planner to use a file-writing custom command and confirm it runs and produces spec files.

**Acceptance Scenarios**:

1. **Given** both `planner` and `implementer` sections reference the same local API provider (e.g., Ollama), **When** the user runs a workflow, **Then** the planner successfully calls that provider and the workflow proceeds without a "planner does not support local providers" error.
2. **Given** a `planner` section with the file-writing agent kind and a valid command that writes `spec.md`, `plan.md`, and `tasks.md` to the project directory, **When** the user runs a workflow, **Then** the tool invokes the command and loads the generated files as the planning output.
3. **Given** a user sets a temperature value on the planner (currently supported only on the implementer), **When** the workflow runs, **Then** the tool accepts the value without rejecting it as an "implementer-only field".
4. **Given** a user swaps an implementer config section verbatim into the planner section (with all the same backend fields), **When** the workflow runs, **Then** the tool accepts the config and runs without schema errors.

---

### User Story 3 - Existing configs keep working via auto-migration (Priority: P2)

A tiny-spec user has a working `.tiny-spec/config.yml` from before this refactor. They pull the latest code and run a command. The tool MUST detect the old shape, upgrade it in place to the new shape, and continue without asking the user to do anything. Known providers (Ollama, LM Studio, Anthropic, OpenRouter, DeepSeek) MUST have their API base URL auto-filled from an internal catalog during the upgrade. Unknown providers MUST produce a clear error naming the missing field.

**Why this priority**: tiny-spec is pre-deployment so nobody is production-dependent on the old shape, but contributors and early users still have local configs. Auto-migration eliminates friction. It is P2 because it is not a user-blocking concern for everyone — only for people with pre-existing configs.

**Independent Test**: Drop a pre-refactor `config.yml` (with `kind: 'claude-code'` or `kind: 'api', tool: 'ollama'`) into a test project, run `tiny-spec start "test"`, confirm it loads successfully. Then trigger a save (via the settings overlay or a picker commit), inspect the file on disk, and confirm it has been rewritten to the new shape with `version: 2`.

**Acceptance Scenarios**:

1. **Given** a legacy config with `implementer.kind: 'claude-code'`, **When** the user runs any command, **Then** the tool loads successfully without error and the in-memory config has `kind: 'cli', tool: 'claude-code'`.
2. **Given** a legacy config with `implementer.kind: 'api', tool: 'ollama'` and no `apiBase`, **When** the user runs any command, **Then** the tool loads successfully and the in-memory config has `provider: 'ollama', apiBase: 'http://localhost:11434/v1'` (auto-filled from catalog).
3. **Given** a legacy config with `implementer.kind: 'api', tool: 'my-internal-llm'` (unknown provider) and no `apiBase`, **When** the user runs any command, **Then** the tool aborts with a clear error naming the unknown provider, listing the known providers that would have been auto-filled, and instructing the user to supply `apiBase`.
4. **Given** a successfully loaded legacy config, **When** the config is next saved (via settings overlay or picker commit), **Then** the file on disk is rewritten in the new shape with `version: 2` at the top level.

---

### User Story 4 - Custom self-hosted providers still work (Priority: P2)

A tiny-spec user runs their own internal OpenAI-compatible LLM server. Their config references a provider name (`my-internal-llm`) that is not in the known-providers catalog. They supply the `apiBase` explicitly. The tool MUST accept this config without treating the unknown provider as an error — the only requirement is that `apiBase` is present.

**Why this priority**: This preserves a specific existing capability that the refactor could accidentally break if the implementation were to lock the provider field to a closed list. Calling it out as a user story prevents that regression.

**Independent Test**: Configure an API implementer with a nonsense provider name and a real apiBase (e.g., a local mock server or a public test endpoint). Run `tiny-spec start "test"` and confirm the request reaches the endpoint — no schema error about "unknown provider".

**Acceptance Scenarios**:

1. **Given** a config with `implementer.kind: 'api'`, `provider: 'my-custom'`, `apiBase: 'http://localhost:9000/v1'`, **When** the user runs a workflow, **Then** the tool accepts the config and dispatches requests to `localhost:9000`.
2. **Given** the same config but with `apiBase` omitted, **When** the user runs any command, **Then** the tool aborts with an error stating that `apiBase` is required for custom providers and listing the known providers whose base URL would have been auto-filled.

---

### User Story 5 - Contributors can add a new CLI tool by editing one list (Priority: P3)

A tiny-spec contributor wants to add support for a new CLI tool (e.g., a new AI coding CLI that ships next month). Today this requires adding a schema variant, updating multiple enum lists, updating the picker, updating dispatch logic, and writing duplicated spawn/parse plumbing. After this change, adding a new CLI tool MUST require editing one list (the known CLI tool names); all downstream code MUST pick it up automatically.

**Why this priority**: This is a maintainability concern visible to contributors. It is P3 because it does not affect end users and tiny-spec's CLI tool set changes infrequently. Still worth encoding so we do not regress.

**Independent Test**: A contributor adds a hypothetical entry `test-tool` to the CLI tools list, runs typecheck and tests. The type system MUST surface exactly the places that need follow-up work (e.g., display labels), and no schema duplication MUST be required. The TUI picker MUST show the new tool without any other code changes.

**Acceptance Scenarios**:

1. **Given** the codebase at current HEAD, **When** a contributor adds one string to the CLI tool list and runs typecheck, **Then** the new tool is a valid value for both `planner.tool` and `implementer.tool` without additional schema edits.
2. **Given** the same addition, **When** the contributor launches the TUI and opens the tool picker, **Then** the new tool appears as a valid option for both planner and implementer.

---

### Edge Cases

- **Legacy config with no `kind` field at all**: Migration MUST infer the kind from the shape of the object (a CLI tool name in `tool` means `cli`, the presence of `apiBase` means `api`, the presence of `command` means `shell`). If the shape is ambiguous, migration MUST fall back to a documented default.
- **User supplies a known-provider name with a different `apiBase` than the catalog**: The user-supplied value MUST win. Auto-fill applies only when `apiBase` is empty or missing.
- **User's config mixes new-shape and legacy-shape fields** (e.g., has both `provider` and legacy `tool` in an API section): Migration MUST prefer the new-shape field (`provider`) and discard the legacy field.
- **User's legacy config has `kind: 'api'` with no `tool` and no `provider`**: Migration MUST fall back to a documented per-role default (implementer → `ollama`, planner → `anthropic`).
- **A user switches backend kind mid-session via the picker overlay** (e.g., from API to shell): The commit MUST produce a valid config; it MUST NOT persist an intermediate state with empty required fields. If the user has not supplied enough information to construct a valid new config, the commit MUST be rejected with a clear message.
- **Resume on a workflow where the config was rewritten**: `tiny-spec resume` reloads the config from disk on every run. The persisted workflow state file stores only display strings and does not need migration.
- **Contributor removes a CLI tool from the catalog while a user still has it in their config**: The loader MUST abort with an error naming the removed tool and listing the remaining valid options. (Not auto-migrated because no correct fallback exists.)
- **Two users running the same repo, one with v1 config, one already migrated**: Both MUST see the same behavior — lazy migration is idempotent and transparent.

## Requirements *(mandatory)*

### Functional Requirements

#### Invariant-carrying config

- **FR-001**: The config loader MUST reject any planner or implementer section that contains a field which does not belong to its declared backend kind, with an error message naming the specific invalid field and the expected fields for that kind.
- **FR-002**: The config loader MUST reject any planner or implementer section with an empty or missing required field (API base URL for API kind, command for shell and file-writing-agent kinds, tool for CLI kind), with an error message naming the specific missing field.
- **FR-003**: The config loader MUST reject any CLI-kind runner whose tool identifier is not in the known CLI tool catalog, with an error message listing valid identifiers.
- **FR-004**: The config loader MUST reject any planner or implementer section missing its `kind` discriminant, with an error message listing the 5 valid kinds.
- **FR-005**: All config validation MUST occur at load time before any workflow phase runs. No config-level error MUST surface mid-workflow that was discoverable at load time.

#### Planner/implementer symmetry

- **FR-006**: Every backend kind valid for the implementer MUST also be valid for the planner, and vice versa.
- **FR-007**: The set of valid backend kinds MUST be exactly five: a known CLI tool, an HTTP API endpoint, an arbitrary command that prints code to standard output, an arbitrary command that writes files directly to the project, and the Anthropic Agent SDK.
- **FR-008**: Generation parameters (context length, temperature, timeout) MUST be accepted as optional on both planner and implementer sections. The tool MUST NOT reject a planner config that includes any of these fields.
- **FR-009**: The TUI tool/model picker overlay MUST show the same set of backend options for both planner and implementer selection, with no "this option is only available for implementer" asymmetry.
- **FR-010**: The tool MUST support running a file-writing agent planner backend: a user-specified command that writes `spec.md`, `plan.md`, and `tasks.md` to the project directory, with the tool reading the resulting files as the planning output. This mirrors the existing file-writing agent on the implementer side.

#### Custom provider support

- **FR-011**: The config system MUST accept any non-empty provider identifier for API-kind runners, not restricted to a closed list.
- **FR-012**: When a user configures an API runner with an unknown provider identifier and omits the API base URL, the config loader MUST abort with a clear error naming the provider, listing known providers, and instructing the user to set the base URL explicitly.
- **FR-013**: When a user configures an API runner with a known provider identifier (`ollama`, `lm-studio`, `anthropic`, `openrouter`, `deepseek`) and omits the API base URL, the config loader MUST auto-fill it from the internal catalog.
- **FR-014**: When a user supplies an API base URL that differs from the catalog value for a known provider, the user-supplied value MUST take precedence over the catalog.

#### Migration

- **FR-015**: The config file on disk MUST carry a schema version marker. Configs without a version marker MUST be treated as version 1 and migrated on load.
- **FR-016**: Loading a version-1 config MUST produce an in-memory config in the new shape without prompting the user. Auto-migration MUST handle legacy CLI-tool-as-kind forms (`kind: 'claude-code'` becomes `kind: 'cli', tool: 'claude-code'`), legacy API-as-tool forms (`kind: 'api', tool: 'ollama'` becomes `kind: 'api', provider: 'ollama'`), and missing-kind-inferred-from-shape cases.
- **FR-017**: After a successful load of a version-1 config, the next save operation MUST persist the file in the new version-2 shape. Subsequent loads MUST see version 2 directly without running migration.
- **FR-018**: Migration errors (e.g., custom provider without API base URL, unknown CLI tool name) MUST abort the load with an actionable message. No partial or silently-defaulted config MUST reach the workflow.

#### Single source of truth for display and lookup

- **FR-019**: All code that displays or logs the "currently selected backend" for a role MUST derive the display string from a single shared helper, not read backend-kind-specific fields directly.
- **FR-020**: Cost calculation MUST use the same display-name convention as the TUI and state persistence, producing identical strings for identical configs.
- **FR-021**: Constructing a new backend config (from a picker selection, a CLI command-line override, or a custom-model commit) MUST go through a single shared constructor that validates the inputs and produces a config guaranteed to be valid without further cleanup.
- **FR-022**: When the user switches backend kinds via the TUI picker, the resulting committed config MUST be complete and valid, or the commit MUST be rejected with a clear message. No empty-string or unresolved fields MUST ever be persisted.
- **FR-023**: Known-provider API base URL lookup MUST live in exactly one function. Migration, TUI picker, and default-config creation MUST all call the same function.

#### Internal code architecture

- **FR-024**: Adding a new CLI tool MUST require only adding its identifier to the shared CLI tools list. No schema variant duplication, no parallel picker entry, no new dispatch branch MUST be required.
- **FR-025**: The code path that spawns a command, delivers the prompt, and collects output MUST live in exactly one primitive. Shell-kind and file-writing-agent-kind runners on both planner and implementer sides MUST consume this primitive rather than duplicating spawn logic.
- **FR-026**: Factory creation of the runtime backend from a config MUST be a single generic dispatcher serving both planner and implementer roles — a single file, not two parallel factory files.
- **FR-027**: The umbrella concept for "the thing that runs an AI call" MUST be named consistently across the codebase using the term **Runner**. The word "backend" MUST NOT remain as a type name, file name, or helper function name after this refactor.
- **FR-028**: The runtime factory file MUST use direct imports for all backend factory functions. Deferred imports MUST be reserved for the single case where an optional peer dependency may not be installed on the user's machine.
- **FR-029**: Related config-schema definitions MUST be split into focused files by responsibility (shared field building blocks, planner variants, implementer variants, and the root config assembly), replacing the current monolithic schema file.

#### Runtime cleanup elimination

- **FR-030**: The post-load cross-field runtime check function (`implementerCrossFieldErrors` in the current codebase) MUST be deleted. Every constraint it currently enforces MUST instead be expressed by the config schema itself.
- **FR-031**: The picker's silent-fallback transformation function (`toImplementerKind` in the current codebase) MUST be deleted. Picker selections MUST go through the same constructor used for CLI overrides.
- **FR-032**: The picker's manual apiBase lookup function (`implementerApiPatch` in the current codebase) MUST be deleted. The single shared known-provider catalog function MUST replace it.
- **FR-033**: The implementer factory's silent fallback when `kind` is undefined MUST be removed. A missing `kind` MUST be a hard validation error at load time, not silently-defaulted runtime behavior.
- **FR-034**: Pre-load manual config merging logic (currently used to combine defaults with user config before schema validation) MUST be removed where it can be expressed directly by the schema.

### Key Entities

- **Runner**: The umbrella concept. A runner is "the thing that runs an AI call." Each runner has a kind (one of 5), some runner-specific fields (tool name for CLI, API base URL for API, command for shell or file-writing agent, API key for Agent SDK), and optional generation parameters (model name, context length, temperature, timeout). Runners exist in two roles: **planner runners** (produce spec/plan/tasks) and **implementer runners** (produce code for a task). The Runner concept is a config-layer entity; it describes what the user picked, not how the runtime behaves.
- **Planner Config**: A runner plus optional generation parameters, describing what the tool should use to produce spec/plan/tasks.
- **Implementer Config**: A runner plus optional generation parameters, describing what the tool should use to produce code for each task.
- **Config Version**: A marker on the root config file identifying the schema version. Enables future migrations without ambiguity.
- **Known Provider Catalog**: A small internal list mapping known API provider identifiers (`ollama`, `lm-studio`, `anthropic`, `openrouter`, `deepseek`) to their default API base URLs. Single source of truth for auto-fill and UI defaults.
- **CLI Tool Catalog**: A small internal list of known CLI tool identifiers usable with the CLI runner kind. Editing this list is the only step needed to add a new CLI tool.
- **Runner Display Name**: The short identifier shown to the user in the TUI and written to the workflow state on disk. Derived from the runner by a single shared function.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of config files that pass load will also successfully start a workflow. No config-level error (field shape, missing field, unknown identifier) will occur after the load step.
- **SC-002**: Adding a new CLI tool to the supported set requires editing exactly one list in one file. The number of files a contributor must touch to add one CLI tool drops from the current count (6+) to 1.
- **SC-003**: The number of runtime cleanup / workaround functions in the config-handling code drops to zero. Specifically, the 4 named functions (`implementerCrossFieldErrors`, `toImplementerKind`, `implementerApiPatch`, and the silent fallback in `createImplementer`) are all removed.
- **SC-004**: The config schema module splits from one monolithic file (~285 lines) into at most 4 focused files, each below 100 lines, with no loss of coverage.
- **SC-005**: A tiny-spec user with any legacy config shape can upgrade to the new version by pulling the code and running any command — no manual YAML editing required. Success is measured by: zero user reports of "how do I migrate my config".
- **SC-006**: Planner and implementer configs accept 100% identical field shapes. If a block of config validates under the `planner:` key, the identical block also validates under the `implementer:` key, and vice versa. Verifiable by automated schema round-trip tests.
- **SC-007**: The TUI tool/model picker shows identical backend options for the planner and implementer roles. Verifiable by a UI smoke test enumerating both pickers.
- **SC-008**: Net lines of code across all config-related source files drop by at least 15% despite adding migration logic, a new planner backend, and file splitting (i.e., net simplification after all additions).
- **SC-009**: All existing tests continue to pass. The refactor adds new tests covering migration cases (at least 5 scenarios), constructor cases (at least 5 scenarios), and display-name cases (at least 5 scenarios). Zero tests are skipped or deleted except those that specifically tested the deleted runtime cleanup functions.
- **SC-010**: A contributor unfamiliar with the config module can read the schema files top to bottom and understand the 5 runner kinds in under 5 minutes. Verifiable by a brief onboarding review.

## Assumptions

- tiny-spec is pre-deployment. No external users are locked into the old config shape. A clean break with lazy in-place migration is acceptable — no separate migration command or compatibility mode is needed.
- The workflow state file on disk (`.tiny-spec/current/state.json`) stores only display strings and a small amount of workflow progress; it does NOT store full config shapes. Resume does not need state migration because the config is reloaded from the YAML file on every resume.
- The TUI event stream (how the engine passes data to the UI) is already cleanly structured. No changes to event types or event flow are needed by this refactor.
- The `Planner` and `Implementer` runtime interfaces stay as they are. The planner retains its 6 methods (plan / regenerate / escalateHint / escalateFull / quickPlan / review) and the implementer retains its 2 methods (implement / retry). Simplifying these interfaces is explicitly out of scope.
- The existing distinction between shell-kind runners (parse stdout for code blocks) and file-writing-agent-kind runners (watch the filesystem for file writes) is semantically real. Both kinds remain; they are not merge candidates.
- The generation parameter `model` is required on implementer runners (local models need an explicit model to load) but optional on planner runners (some CLI planners pick their own default, e.g., Claude Code auto-selects based on the user's subscription).
- Adding a new CLI tool may still require incidental updates for display labels or optional integration details. The claim "edit one list" refers to the schema/validation surface, not every possible presentation concern.
- The Anthropic Agent SDK remains an optional peer dependency. Its loader is the single place where a deferred import is used; the rest of the codebase uses direct imports.
- tiny-spec's existing test suite (700+ tests) stays green throughout the refactor. Every commit in the implementation plan leaves type checking and tests green.
