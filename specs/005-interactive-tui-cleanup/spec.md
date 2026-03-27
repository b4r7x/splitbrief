# Feature Specification: Interactive TUI Picker & Codebase Cleanup

**Feature Branch**: `005-interactive-tui-cleanup`
**Created**: 2026-03-26
**Status**: Draft
**Input**: Interactive TUI picker for planner/implementer selection, subprocess implementer option, and codebase cleanup based on strategic decisions

## User Scenarios & Testing

### User Story 1 — Interactive Setup on Start (Priority: P1)

A user runs `tiny-spec start "add auth"` without any config file. Instead of silently creating defaults and proceeding, the tool shows an interactive picker. It auto-detects which planners are available on the system (e.g., Claude Code installed, Codex installed) and which implementer endpoints are running (e.g., Ollama on localhost:11434 with qwen2.5-coder:7b, LM Studio on localhost:1234 with deepseek-coder). The user selects one planner and one implementer from the list, and the workflow starts.

If config already exists, the tool uses it without prompting (existing behavior preserved). If the user passes `--model` or `--provider` flags, those override without prompting.

**Why this priority**: Eliminates the #1 friction point — new users currently have to understand YAML config before they can do anything. This makes the tool usable in under 30 seconds.

**Independent Test**: Can be tested by running `tiny-spec start "test"` in a project with no `.tiny-spec/config.yaml`, verifying the interactive picker appears, and confirming the selected configuration is used for the workflow.

**Acceptance Scenarios**:

1. **Given** no config exists and Ollama is running with 2 models, **When** user runs `tiny-spec start "feature"`, **Then** an interactive picker shows detected planners and implementer models, user selects, and workflow starts with those choices.
2. **Given** no config exists and no local models are running, **When** user runs `tiny-spec start "feature"`, **Then** the picker shows planners only and prompts for implementer details (provider, model, API base) or offers to create config with defaults.
3. **Given** config exists, **When** user runs `tiny-spec start "feature"`, **Then** workflow starts immediately using config values (no interactive prompt).
4. **Given** no config exists, **When** user runs `tiny-spec start "feature" --model qwen3:8b --provider ollama`, **Then** workflow starts with the specified overrides (no interactive prompt).
5. **Given** the interactive picker is shown, **When** user selects a planner and implementer, **Then** the selection is saved to `.tiny-spec/config.yaml` for future runs.

---

### User Story 2 — Subprocess Implementer (Priority: P2)

A user wants to use a custom bash wrapper or alternative CLI tool as the implementer instead of an OpenAI-compatible API endpoint. They configure `implementer.type: shell` with a command, similar to how the shell planner works. The tool sends the task prompt to the command's stdin and reads the code response from stdout.

This enables use cases like: custom bash functions that wrap other AI tools, local scripts that preprocess prompts, or any command that takes a prompt and returns code.

**Why this priority**: Extends the implementer to support the same pluggability that the planner already has. Unlocks custom workflows without changing core architecture.

**Independent Test**: Can be tested by configuring a shell implementer (e.g., `echo` or a mock script) and running a workflow, verifying the subprocess receives the prompt and its output is processed as code.

**Acceptance Scenarios**:

1. **Given** config has `implementer.type: shell` with `command: my-script`, **When** a task is sent to the implementer, **Then** the tool spawns `my-script`, writes the task prompt to stdin, and reads the response from stdout.
2. **Given** a shell implementer is configured, **When** the subprocess exits with non-zero code, **Then** the task is treated as a failed attempt (triggers retry logic).
3. **Given** a shell implementer is configured, **When** the subprocess returns code wrapped in markdown fences, **Then** the existing code extractor processes it normally.
4. **Given** no `implementer.type` is set, **When** workflow runs, **Then** the default OpenAI API behavior is used (backward compatible).

---

### User Story 3 — Codebase Cleanup (Priority: P3)

The codebase has accumulated inconsistencies from rapid v0.1/v0.2 development. This story addresses concrete issues:

- The `spec` command hardcodes Claude Code planner via a backward-compat wrapper (`planner.ts`) instead of using the pluggable factory. Users who configure a different planner (e.g., Codex, Aider) find that `tiny-spec spec` ignores their choice.
- The backward-compat `planner.ts` wrapper should be removed; the `spec` command should use the planner factory directly.
- Dead or unused code paths should be identified and removed.
- Documentation references should be consistent across CLAUDE.md, README.md, and docs/VISION.md.

**Why this priority**: Technical debt cleanup. No user-facing value on its own but prevents confusion and bugs as the codebase grows.

**Independent Test**: Can be tested by configuring a non-Claude-Code planner and running `tiny-spec spec "test"`, verifying it uses the configured planner. Dead code removal verified by test suite passing after removal.

**Acceptance Scenarios**:

1. **Given** config has `planner.tool: codex`, **When** user runs `tiny-spec spec "feature"`, **Then** the Codex planner is used (not Claude Code).
2. **Given** the backward-compat `planner.ts` wrapper exists, **When** cleanup is complete, **Then** the wrapper is removed and all callers use the planner factory.
3. **Given** dead code exists in the codebase, **When** cleanup is complete, **Then** unused functions, imports, and files are removed, and all tests pass.
4. **Given** documentation exists across multiple files, **When** cleanup is complete, **Then** CLAUDE.md, README.md, and docs/VISION.md have consistent, non-contradictory information.

---

### User Story 4 — Constitution Update (Priority: P3)

The project constitution (`.specify/memory/constitution.md`, v1.0.0) was written during initial v0.1 development and doesn't reflect the strategic decisions made since. Based on `docs/VISION.md` and project direction discussions, the constitution needs to be updated to capture:

- **What tiny-spec is NOT**: not a universal AI connector, not a multi-agent coordinator, not Claude Squad. The cost-optimization focus is the core identity and must be codified as a principle.
- **Pluggable architecture**: Both planner and implementer are pluggable (planner: 6 backends + shell; implementer: OpenAI API + shell). This supersedes the v1.0.0 constraint that hardcoded "Claude Code CLI as subprocess" and "OpenAI-compatible API (no subprocess tools)".
- **Anti-goals as guardrails**: Tool calls for small models, agent-wrapping-agent patterns, and generic orchestration are explicitly rejected. These should be constitutional constraints to prevent future scope creep.

The constitution update uses `/speckit.constitution` to ensure proper versioning and template sync.

**Why this priority**: The constitution is the governing document for all development decisions. Without updating it, new contributors or AI sessions may make decisions that contradict the agreed strategic direction.

**Independent Test**: Can be tested by reading the updated constitution and verifying it aligns with `docs/VISION.md` strategic decisions. Version must be bumped (MINOR — new principles added).

**Acceptance Scenarios**:

1. **Given** the current constitution is v1.0.0, **When** the update is complete, **Then** the version is bumped to v1.1.0 (MINOR — new principles, no removals).
2. **Given** `docs/VISION.md` defines anti-goals, **When** the constitution is updated, **Then** anti-goals are codified as constitutional constraints.
3. **Given** the technical constraints section says "Planner: Claude Code CLI as subprocess", **When** the constitution is updated, **Then** it reflects the pluggable planner/implementer architecture.
4. **Given** the constitution is updated, **When** a new AI session loads the skill, **Then** it can determine what NOT to build from the constitution alone.

---

### Edge Cases

- What happens when the interactive picker detects zero planners? Show an error with installation instructions for supported planners.
- What happens when a shell implementer command is not found on PATH? Show a clear error before starting the workflow, not mid-task.
- What happens when a shell implementer produces output that contains no extractable code? Treat as failed attempt, include the raw output in the retry prompt.
- What happens when the user cancels the interactive picker (Ctrl+C)? Exit cleanly with code 0, no partial config written.

## Clarifications

### Session 2026-03-26

- Q: Should the constitution update be a separate user story or folded into US3 cleanup? → A: New User Story 4 (P3) — dedicated story with specific principles to add/revise.
- Q: Should the `spec` command also get the interactive picker when no config exists? → A: No — `spec` just needs the factory fix (FR-013/FR-014). No picker. Keep it minimal.
- Q: Should conversational planning (interactive spec creation with clarifications in TUI) be part of this feature? → A: No — separate spec `006-conversational-planning`. Do cleanup/infrastructure first (005), then build conversational mode on clean base (006).

## Requirements

### Functional Requirements

**Interactive TUI Picker**:

- **FR-001**: System MUST auto-detect available planner tools on the system (check if `claude`, `codex`, `opencode`, `aider` commands exist on PATH).
- **FR-002**: System MUST auto-detect running implementer endpoints (probe Ollama and LM Studio default ports, list available models).
- **FR-003**: System MUST show an interactive selection menu when no config file exists and no CLI overrides are provided.
- **FR-004**: System MUST save the user's selection to `.tiny-spec/config.yaml` after interactive setup.
- **FR-005**: System MUST skip the interactive picker when config already exists OR when CLI flags provide overrides.
- **FR-006**: The `init` command MUST also use the interactive picker with planner detection (currently it only detects implementer models).

**Subprocess Implementer**:

- **FR-007**: System MUST support `implementer.type: shell` configuration option alongside the default `api` type.
- **FR-008**: When type is `shell`, system MUST spawn the configured command, write the task prompt to stdin, and read code from stdout.
- **FR-009**: Shell implementer MUST reuse the existing code extractor for processing output (markdown fences, explanation stripping).
- **FR-010**: Shell implementer MUST report non-zero exit codes as task failures, triggering retry logic.
- **FR-011**: Shell implementer MUST validate that the configured command exists before starting the workflow.
- **FR-012**: When `implementer.type` is not set, system MUST default to `api` behavior (backward compatible).

**Codebase Cleanup**:

- **FR-013**: The `spec` command MUST use the planner factory (`createPlanner`) instead of the hardcoded Claude Code wrapper.
- **FR-014**: The backward-compat `src/orchestrator/planner.ts` wrapper MUST be removed.
- **FR-015**: All dead imports, unused functions, and unreachable code paths MUST be identified and removed.
- **FR-016**: Documentation across CLAUDE.md, README.md, and docs/VISION.md MUST be reviewed for consistency and updated.

**Constitution Update**:

- **FR-017**: The constitution MUST be updated to codify cost-optimization as the core identity and explicitly reject universal-connector scope.
- **FR-018**: The constitution's Technical Constraints section MUST be updated to reflect the pluggable planner/implementer architecture (replacing hardcoded Claude Code / OpenAI-only references).
- **FR-019**: The constitution MUST add anti-goals as constitutional constraints: no tool calls for small models, no agent-wrapping-agent, no generic multi-agent orchestration.
- **FR-020**: The constitution version MUST be bumped from 1.0.0 to 1.1.0 (MINOR — new principles added, no principles removed).

### Key Entities

- **PlannerDetection**: Represents a detected planner tool — name, whether it's available on the system.
- **ImplementerDetection**: Represents a detected implementer — provider name, base URL, list of available models.
- **ShellImplementer**: Configuration for subprocess-based implementer — command, args, environment.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A new user with Ollama running can go from `npm install -g tiny-spec` to a running workflow in under 60 seconds without editing any config file.
- **SC-002**: Users can configure any shell command as the implementer and have it receive task prompts and return code.
- **SC-003**: The `tiny-spec spec` command respects the configured planner tool (not hardcoded to Claude Code).
- **SC-004**: All existing tests pass after cleanup, with no reduction in test count.
- **SC-005**: No backward-compat wrappers or dead code remain in the codebase after cleanup.

## Assumptions

- Planner detection checks PATH for known command names (`claude`, `codex`, `opencode`, `aider`). It does not verify the tool is authenticated or functional — just present.
- The interactive picker uses Ink components (consistent with existing TUI) rather than raw readline, since the app already depends on Ink.
- Shell implementer follows the same stdin/stdout contract as the shell planner: prompt written to stdin, response read from stdout, cwd set to project directory.
- Config file format remains YAML. No migration or format change.
- The `init` command's existing model detection logic is reused and extended, not rewritten.
