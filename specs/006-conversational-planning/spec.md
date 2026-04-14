# Feature Specification: Interactive UX Overhaul & Codebase Cleanup

**Feature Branch**: `006-conversational-planning`
**Created**: 2026-03-26
**Status**: Draft
**Input**: Conversational planning, interactive TUI picker, subprocess implementer, codebase cleanup, constitution update — unified in one implementation pass

## User Scenarios & Testing

### User Story 1 — Conversational Spec Creation (Priority: P1)

A user runs `diptych start "add user auth with JWT"`. The planner researches the codebase, then instead of silently generating a complete spec, it engages the user in a conversation. The TUI shows the planner's findings and asks targeted questions:

- "I found Express + Passport in your codebase. Do you want JWT or session-based auth?"
- "Should refresh tokens have automatic rotation?"
- "I see you have a `users` table. Should I reuse it or create a separate auth table?"

The user answers directly in the TUI. Each answer is immediately recorded in `.diptych/current/spec.md` under a Clarifications section. After the questions are resolved, the planner generates the final spec.md incorporating all answers.

The user can also open spec.md in their editor at any point during this process to make manual edits. The planner picks up file changes at phase boundaries.

**Why this priority**: This is the core differentiator from every other tool. No one else does conversational spec creation with file-based persistence. It's the #1 thing that makes diptych better than running Claude Code directly.

**Independent Test**: Can be tested by running `diptych start "test feature"` and verifying: (a) planner asks at least one clarifying question in the TUI, (b) the answer appears in spec.md under Clarifications, (c) the final spec reflects the answer.

**Acceptance Scenarios**:

1. **Given** the planner has researched the codebase, **When** there are ambiguities in the feature request, **Then** the planner asks up to 5 targeted questions in the TUI before generating the spec.
2. **Given** a question is displayed in the TUI, **When** the user types an answer and presses Enter, **Then** the answer is recorded in `.diptych/current/spec.md` under `## Clarifications` immediately.
3. **Given** the user is in the clarification phase, **When** the user opens spec.md in $EDITOR and modifies content, **Then** the planner detects the change at the next phase boundary and incorporates it.
4. **Given** the planner has no ambiguities (feature request is clear), **When** research is complete, **Then** the planner skips questions and generates the spec directly.
5. **Given** clarifications are complete, **When** the planner generates the spec, **Then** spec.md contains all clarification answers integrated into the relevant sections (not just appended).

---

### User Story 2 — Interactive Plan Review (Priority: P1)

After the spec is generated, the user reviews and approves it. Then the planner generates plan.md and tasks.md. At each gate (spec review, plan review), the user has three options beyond the current approve/reject:

- **Approve**: Continue to next phase.
- **Edit**: Open the file in $EDITOR, make changes, return. Planner sees the edits.
- **Comment**: Type feedback directly in the TUI. Planner regenerates the artifact incorporating the feedback.

This replaces the current binary approve/reject with a richer interaction where the user can iteratively refine the plan without leaving the TUI.

**Why this priority**: The current approve/reject flow loses nuance. Users often want to approve "mostly" but tweak details. Commenting in TUI is faster than opening an editor for small changes.

**Independent Test**: Can be tested by running the workflow, choosing "comment" at the plan review gate, typing feedback like "split task 7 into two smaller tasks", and verifying the plan is regenerated with the change.

**Acceptance Scenarios**:

1. **Given** spec.md is generated, **When** the TUI shows the approval prompt, **Then** the user sees options: [Enter] approve, [e] edit in $EDITOR, [c] comment, [q] quit.
2. **Given** the user chooses "comment", **When** they type feedback and press Enter, **Then** the planner regenerates the artifact incorporating the feedback.
3. **Given** the user chooses "edit" and modifies the file, **When** they close the editor, **Then** the planner detects changes and proceeds with the edited version.
4. **Given** the user approves spec.md, **When** the planner generates plan.md, **Then** plan.md references the clarifications and decisions from the spec.
5. **Given** the user comments on plan.md, **When** the planner regenerates it, **Then** the previous plan is overwritten (not appended) and the new plan reflects the feedback.

---

### User Story 3 — Interactive Setup on Start (Priority: P1)

A user runs `diptych start "add auth"` without any config file. Instead of silently creating defaults, the tool shows an interactive picker. It auto-detects which planners are available on the system (e.g., Claude Code installed, Codex installed) and which implementer endpoints are running (e.g., Ollama with qwen2.5-coder:7b, LM Studio with deepseek-coder). The user selects one planner and one implementer from the list, and the workflow starts.

If config already exists, the tool uses it without prompting. If the user passes `--model` or `--provider` flags, those override without prompting.

**Why this priority**: Eliminates the #1 friction point — new users currently have to understand YAML config before they can do anything.

**Independent Test**: Can be tested by running `diptych start "test"` in a project with no `.diptych/config.yaml`, verifying the interactive picker appears, and confirming the selected configuration is used.

**Acceptance Scenarios**:

1. **Given** no config exists and Ollama is running with 2 models, **When** user runs `diptych start "feature"`, **Then** an interactive picker shows detected planners and implementer models, user selects, and workflow starts with those choices.
2. **Given** no config exists and no local models are running, **When** user runs `diptych start "feature"`, **Then** the picker shows planners only and prompts for implementer details or offers defaults.
3. **Given** config exists, **When** user runs `diptych start "feature"`, **Then** workflow starts immediately using config values (no interactive prompt).
4. **Given** no config exists, **When** user runs `diptych start "feature" --model qwen3:8b --provider ollama`, **Then** workflow starts with the specified overrides (no interactive prompt).
5. **Given** the interactive picker is shown, **When** user selects a planner and implementer, **Then** the selection is saved to `.diptych/config.yaml` for future runs.

---

### User Story 4 — Planner-Driven Question Protocol (Priority: P2)

The planner decides when and what to ask. The system doesn't hardcode questions — instead, the planner prompt instructs it to identify ambiguities after research and formulate questions. The planner outputs questions in a structured format that the TUI can parse and present.

Questions are:
- Targeted (based on actual codebase findings, not generic)
- Limited (max 5 per session to avoid fatigue)
- Prioritized (planner asks highest-impact questions first)
- Optional (user can say "skip" or "no more questions" to proceed with planner's best guess)

**Why this priority**: The quality of questions determines the quality of the spec. Generic questions are useless if the planner already found the answer in the codebase. Codebase-aware questions are valuable.

**Independent Test**: Can be tested by providing a feature request with obvious ambiguities, verifying the planner asks relevant questions, and verifying generic/unhelpful questions are not asked.

**Acceptance Scenarios**:

1. **Given** the planner has researched the codebase, **When** it identifies ambiguities, **Then** it outputs questions in a parseable format (structured markers in its output stream).
2. **Given** a question is presented, **When** the user types "skip", **Then** the planner makes its best guess and notes the assumption in spec.md.
3. **Given** 5 questions have been asked, **When** the planner has more ambiguities, **Then** it stops asking and proceeds with best guesses (noted as assumptions).
4. **Given** the feature request is unambiguous, **When** research is complete, **Then** the planner outputs zero questions and proceeds to spec generation.
5. **Given** the user says "no more questions" after question 2, **When** the planner proceeds, **Then** remaining ambiguities are resolved with best guesses noted as assumptions.

---

### User Story 5 — File-Based Source of Truth (Priority: P2)

All planning artifacts are persisted as markdown files in `.diptych/current/`. The user can inspect, edit, or version-control these files independently. The files are the source of truth — what's in the file is what the planner uses, regardless of what was said in the TUI conversation.

Files produced during planning:
- `spec.md` — Feature specification with clarifications section
- `plan.md` — Implementation plan with architecture decisions
- `tasks.md` — Atomic tasks for the implementer

Each file is written immediately when generated (not buffered until approval).

**Why this priority**: Files survive session crashes, can be reviewed offline, and are auditable. The TUI is a convenience layer — the files are what matter.

**Independent Test**: Can be tested by running the workflow, killing the process mid-planning, and verifying that partial spec.md/plan.md exist and contain the work done so far.

**Acceptance Scenarios**:

1. **Given** the planner is generating spec.md, **When** the file is written, **Then** it follows a consistent markdown structure with standard sections (Overview, Scenarios, Requirements, Clarifications, Assumptions).
2. **Given** spec.md was manually edited by the user between spec and plan phases, **When** the planner generates plan.md, **Then** the plan reflects the edited spec (not the original).
3. **Given** the process is interrupted, **When** the user runs `diptych resume`, **Then** the workflow picks up from the last completed phase using existing files.
4. **Given** clarifications are answered in the TUI, **When** the spec is written, **Then** each Q&A appears as a bullet under `## Clarifications` with date-stamped session header.

---

### User Story 6 — Subprocess Implementer (Priority: P2)

A user wants to use a custom bash wrapper or alternative CLI tool as the implementer instead of an OpenAI-compatible API endpoint. They configure `implementer.type: shell` with a command, similar to how the shell planner works. The tool sends the task prompt to the command's stdin and reads the code response from stdout.

This enables use cases like: custom bash functions that wrap other AI tools, local scripts that preprocess prompts, or any command that takes a prompt and returns code.

**Why this priority**: Extends the implementer to support the same pluggability that the planner already has.

**Independent Test**: Can be tested by configuring a shell implementer (e.g., `echo` or a mock script) and running a workflow, verifying the subprocess receives the prompt and its output is processed as code.

**Acceptance Scenarios**:

1. **Given** config has `implementer.type: shell` with `command: my-script`, **When** a task is sent to the implementer, **Then** the tool spawns `my-script`, writes the task prompt to stdin, and reads the response from stdout.
2. **Given** a shell implementer is configured, **When** the subprocess exits with non-zero code, **Then** the task is treated as a failed attempt (triggers retry logic).
3. **Given** a shell implementer is configured, **When** the subprocess returns code wrapped in markdown fences, **Then** the existing code extractor processes it normally.
4. **Given** no `implementer.type` is set, **When** workflow runs, **Then** the default OpenAI API behavior is used (backward compatible).

---

### User Story 7 — Codebase Cleanup (Priority: P3)

The codebase has accumulated inconsistencies from rapid v0.1/v0.2 development:

- The `spec` command hardcodes Claude Code planner via a backward-compat wrapper (`planner.ts`) instead of using the pluggable factory.
- The backward-compat `planner.ts` wrapper should be removed; the `spec` command should use the planner factory directly.
- Dead or unused code paths should be identified and removed.
- Documentation references should be consistent across CLAUDE.md, README.md, and docs/VISION.md.

**Why this priority**: Technical debt cleanup. Prevents confusion and bugs as the codebase grows. Also provides a clean foundation for the new conversational features.

**Independent Test**: Can be tested by configuring a non-Claude-Code planner and running `diptych spec "test"`, verifying it uses the configured planner. Dead code removal verified by test suite passing after removal.

**Acceptance Scenarios**:

1. **Given** config has `planner.tool: codex`, **When** user runs `diptych spec "feature"`, **Then** the Codex planner is used (not Claude Code).
2. **Given** the backward-compat `planner.ts` wrapper exists, **When** cleanup is complete, **Then** the wrapper is removed and all callers use the planner factory.
3. **Given** dead code exists in the codebase, **When** cleanup is complete, **Then** unused functions, imports, and files are removed, and all tests pass.
4. **Given** documentation exists across multiple files, **When** cleanup is complete, **Then** CLAUDE.md, README.md, and docs/VISION.md have consistent, non-contradictory information.

---

### User Story 8 — Constitution Update (Priority: P3)

The project constitution (`.specify/memory/constitution.md`, v1.0.0) was written during initial v0.1 development and doesn't reflect the strategic decisions made since. Based on `docs/VISION.md` and project direction discussions, the constitution needs to be updated to capture:

- **What diptych is NOT**: not a universal AI connector, not a multi-agent coordinator, not Claude Squad. The cost-optimization focus is the core identity.
- **Pluggable architecture**: Both planner and implementer are pluggable. This supersedes the v1.0.0 constraint that hardcoded "Claude Code CLI as subprocess" and "OpenAI-compatible API (no subprocess tools)".
- **Anti-goals as guardrails**: Tool calls for small models, agent-wrapping-agent patterns, and generic orchestration are explicitly rejected.

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
- What happens when the planner backend doesn't support multi-turn (e.g., shell planner)? Fall back to batch mode: generate spec without questions, show approval prompt.
- What happens when a shell implementer command is not found on PATH? Show a clear error before starting the workflow, not mid-task.
- What happens when a shell implementer produces output that contains no extractable code? Treat as failed attempt, include the raw output in the retry prompt.
- What happens when the user cancels the interactive picker (Ctrl+C)? Exit cleanly with code 0, no partial config written.
- What happens when the user doesn't respond to a question for a long time? No timeout — the TUI waits. The spec file contains everything generated so far.
- What happens when the user edits spec.md while the planner is mid-generation? The planner's current generation completes first, then on the next read it picks up user changes.
- What happens when the planner's questions are poorly formatted (parser can't extract them)? Show the raw planner output in the TUI as fallback.

## Clarifications

### Session 2026-03-26

- Q: Should the constitution update be a separate user story or folded into cleanup? → A: Separate User Story 8 (P3) — dedicated story with specific principles to add/revise.
- Q: Should the `spec` command get the interactive picker? → A: No — `spec` just needs the factory fix. No picker. Keep it minimal.
- Q: Should conversational planning be a separate feature branch? → A: No — everything in one branch (006), one spec, one implementation pass.

### Post-Implementation Discoveries (2026-03-26)

- **Shell implementer (US6) is too simple for agent-style tools**: The stdin/stdout model works for "dumb" code generators (scripts that take prompt, return code) but NOT for full coding agents like claude-zai (Claude Code wrapper). Problems: bash functions aren't visible to `spawn()`, agents manage their own files (conflicts with diptych's `applyCode()`), the stdin/stdout contract doesn't support stream-json/sessions. This fundamentally challenges Decision #5 ("Don't wrap agents in agents") — if users WANT to use an agent as implementer, we need a different abstraction.
- **Interactive TUI not battle-tested**: All conversational flow code (question asking, comment-on-approval, regeneration loop) was implemented by AI agents but never tested end-to-end with real Claude Code + real Ollama. The happy path likely works but edge cases and UX may have issues.
- **Claude Code CLI compatibility**: v2.1.84 requires `--verbose` flag for `stream-json` + `-p`. Fixed, but shows the CLI API is unstable — version detection or graceful fallback needed.
- **Open decision**: Should implementer support an "agent mode" where it manages its own file writes and diptych only validates + commits? Or keep the current "implementer returns code text only" model? This needs a design discussion before more implementation.

## Requirements

### Functional Requirements

**Conversational Flow**:

- **FR-001**: The planning phase MUST support a conversational mode where the planner asks clarifying questions before generating the spec.
- **FR-002**: Questions MUST be presented one at a time in the TUI with a text input for the user's answer.
- **FR-003**: Each answered question MUST be immediately written to spec.md under a `## Clarifications` section with a date-stamped session header.
- **FR-004**: The user MUST be able to skip individual questions (planner uses best guess, noted as assumption).
- **FR-005**: The user MUST be able to stop all questions early (remaining ambiguities resolved with assumptions).
- **FR-006**: The planner MUST ask a maximum of 5 questions per planning session.
- **FR-007**: Planners that don't support multi-turn MUST fall back to batch mode (no questions, direct spec generation).

**Interactive Review**:

- **FR-008**: At each approval gate (spec, plan), the user MUST have options: approve, edit in $EDITOR, comment in TUI, or quit.
- **FR-009**: When the user comments, the planner MUST regenerate the artifact incorporating the feedback.
- **FR-010**: When the user edits a file in $EDITOR, the planner MUST use the edited version for subsequent phases.
- **FR-011**: Regenerated artifacts MUST overwrite the previous version (not append).

**File Persistence**:

- **FR-012**: All planning artifacts (spec.md, plan.md, tasks.md) MUST be written to `.diptych/current/` immediately upon generation.
- **FR-013**: Clarifications MUST be persisted in spec.md as structured bullets: `- Q: <question> → A: <answer>`.
- **FR-014**: Interrupted workflows MUST be resumable from the last completed phase using existing files.
- **FR-015**: The file content is the source of truth — TUI is a display/input layer only.

**Question Protocol**:

- **FR-016**: The planner prompt MUST instruct the planner to identify ambiguities based on codebase research, not generic templates.
- **FR-017**: Questions MUST be output in a parseable format within the planner's response stream (structured markers).
- **FR-018**: The TUI MUST parse question markers from the planner output and render them as interactive prompts.
- **FR-019**: If question parsing fails, the TUI MUST display the raw planner output as fallback.

**Prompt Templates**:

- **FR-020**: The research prompt MUST be updated to instruct the planner to identify ambiguities and formulate targeted questions.
- **FR-021**: The spec prompt MUST accept clarification answers as input and integrate them into the generated spec.
- **FR-022**: The plan prompt MUST reference the clarifications section from the spec when generating the plan.

**Interactive TUI Picker**:

- **FR-023**: System MUST auto-detect available planner tools on the system (check if `claude`, `codex`, `opencode`, `aider` commands exist on PATH).
- **FR-024**: System MUST auto-detect running implementer endpoints (probe Ollama and LM Studio default ports, list available models).
- **FR-025**: System MUST show an interactive selection menu when no config file exists and no CLI overrides are provided.
- **FR-026**: System MUST save the user's selection to `.diptych/config.yaml` after interactive setup.
- **FR-027**: System MUST skip the interactive picker when config already exists OR when CLI flags provide overrides.
- **FR-028**: The `init` command MUST also use the interactive picker with planner detection (currently it only detects implementer models).

**Subprocess Implementer**:

- **FR-029**: System MUST support `implementer.type: shell` configuration option alongside the default `api` type.
- **FR-030**: When type is `shell`, system MUST spawn the configured command, write the task prompt to stdin, and read code from stdout.
- **FR-031**: Shell implementer MUST reuse the existing code extractor for processing output (markdown fences, explanation stripping).
- **FR-032**: Shell implementer MUST report non-zero exit codes as task failures, triggering retry logic.
- **FR-033**: Shell implementer MUST validate that the configured command exists before starting the workflow.
- **FR-034**: When `implementer.type` is not set, system MUST default to `api` behavior (backward compatible).

**Codebase Cleanup**:

- **FR-035**: The `spec` command MUST use the planner factory (`createPlanner`) instead of the hardcoded Claude Code wrapper.
- **FR-036**: The backward-compat `src/orchestrator/planner.ts` wrapper MUST be removed.
- **FR-037**: All dead imports, unused functions, and unreachable code paths MUST be identified and removed.
- **FR-038**: Documentation across CLAUDE.md, README.md, and docs/VISION.md MUST be reviewed for consistency and updated.

**Constitution Update**:

- **FR-039**: The constitution MUST be updated to codify cost-optimization as the core identity and explicitly reject universal-connector scope.
- **FR-040**: The constitution's Technical Constraints section MUST be updated to reflect the pluggable planner/implementer architecture.
- **FR-041**: The constitution MUST add anti-goals as constitutional constraints: no tool calls for small models, no agent-wrapping-agent, no generic multi-agent orchestration.
- **FR-042**: The constitution version MUST be bumped from 1.0.0 to 1.1.0 (MINOR — new principles added, no principles removed).

### Key Entities

- **ClarificationQuestion**: A question from the planner — text, options (if multiple choice), default answer, priority.
- **ClarificationAnswer**: User's response — question reference, answer text, source (TUI input or file edit), timestamp.
- **ReviewFeedback**: User's comment at an approval gate — artifact type (spec/plan), feedback text, resulting action (regenerate).
- **PlanningSession**: Tracks the conversational state — questions asked, answers received, files generated, current phase.
- **PlannerDetection**: Represents a detected planner tool — name, whether it's available on the system.
- **ImplementerDetection**: Represents a detected implementer — provider name, base URL, list of available models.
- **ShellImplementer**: Configuration for subprocess-based implementer — command, args, environment.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Users can answer clarifying questions directly in the TUI without leaving the terminal or editing files.
- **SC-002**: Every clarification answer is persisted in spec.md — no information is lost if the session crashes.
- **SC-003**: Users can refine the plan by commenting in the TUI, and the planner regenerates the artifact within the same session.
- **SC-004**: Planners that don't support multi-turn still work in batch mode with no errors.
- **SC-005**: The full planning flow (research → clarify → spec → review → plan → review → tasks) completes in a single `diptych start` invocation.
- **SC-006**: A new user with Ollama running can go from `npm install -g diptych` to a running workflow in under 60 seconds without editing any config file.
- **SC-007**: Users can configure any shell command as the implementer and have it receive task prompts and return code.
- **SC-008**: The `diptych spec` command respects the configured planner tool (not hardcoded to Claude Code).
- **SC-009**: All existing tests pass after cleanup, with no reduction in test count.
- **SC-010**: No backward-compat wrappers or dead code remain in the codebase after cleanup.

## Assumptions

- Multi-turn conversational mode works with Claude Code (session IDs) and agent-sdk (programmatic). Other backends (codex, aider, shell) fall back to batch mode.
- The question format in the planner's output stream uses a simple marker protocol (e.g., `[QUESTION]...[/QUESTION]`) that can be parsed from streaming text.
- $EDITOR support uses the existing `spawnSync` approach (already in prompt.tsx).
- The planner is responsible for question quality — the system doesn't validate whether questions are "good." Bad questions are a prompt engineering problem, not a system problem.
- File watching is NOT implemented. The planner reads the file at phase boundaries (before plan generation, before task generation), not continuously.
- The `spec` command (standalone spec generation without implementation) also benefits from conversational mode if the planner supports it.
- Planner detection checks PATH for known command names (`claude`, `codex`, `opencode`, `aider`). It does not verify the tool is authenticated or functional — just present.
- The interactive picker uses Ink components (consistent with existing TUI) rather than raw readline.
- Shell implementer follows the same stdin/stdout contract as the shell planner: prompt written to stdin, response read from stdout, cwd set to project directory.
- Config file format remains YAML. No migration or format change.
- The `init` command's existing model detection logic is reused and extended, not rewritten.
