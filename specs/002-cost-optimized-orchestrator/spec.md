# Feature Specification: tiny-spec v0.1 -- Cost-Optimized AI Coding Orchestrator

**Feature Branch**: `002-cost-optimized-orchestrator`
**Created**: 2026-03-25
**Status**: Draft
**Input**: User description: "CLI tool that uses expensive AI (Opus) for planning/specs and cheap/local AI (Ollama/LM Studio) for implementation, saving 50%+ on AI coding costs"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Full Workflow: Spec-to-Implementation Pipeline (Priority: P1)

A developer on the Claude Max 5x plan ($100/mo) has a feature to build. Instead of burning all their Opus tokens on implementation (55-60% of typical usage), they run `tiny-spec start "add user authentication"`. The tool uses Opus to research the codebase, write a detailed specification, break it into atomic tasks with test expectations, and generate self-contained implementation prompts. Then it feeds each task one-by-one to a cheap/local model (e.g., Qwen 2.5 Coder 7B via Ollama). After each task, automated validation runs (typecheck, lint, test). If it passes, changes are committed and the next task starts. If it fails, the local model gets the error feedback and retries (max 3). If still failing, Opus receives a hint request first; if that doesn't help, Opus implements the fix directly. After all tasks, Opus reviews the full diff against the original spec.

**Why this priority**: This is the entire product. Without the end-to-end pipeline, there is no value proposition. Every other user story is a subset of this one.

**Independent Test**: Can be fully tested by running `tiny-spec start "add a hello world endpoint"` on a minimal project and verifying that tasks are planned by Opus, implemented by the local model, validated, committed, and reviewed.

**Acceptance Scenarios**:

1. **Given** a project directory with a running Ollama instance, **When** the user runs `tiny-spec start "add user authentication"`, **Then** the tool opens a split-pane TUI with Claude Code output on the left and implementer activity on the right, starts the planning phase, and streams Claude Code's output in real-time in the left pane.

2. **Given** a running planning phase, **When** Opus finishes generating the specification, **Then** the spec is saved to `.tiny-spec/current/spec.md` and the user is prompted to review it (via `$EDITOR` or approval prompt).

3. **Given** an approved spec, **When** the planning phase continues, **Then** Opus generates a plan and atomic task list, each task containing: the function to implement, exact types, current code context (inlined), test expectations with concrete values, and constraints.

4. **Given** tasks ready for implementation, **When** the implementation phase begins, **Then** each task prompt is sent to the local model via the OpenAI-compatible API, the model's code output is parsed (stripped of markdown fences and explanations), and written to the target file.

5. **Given** a completed task implementation, **When** validation runs, **Then** the system executes typecheck, lint, and affected tests in order, stopping on first failure.

6. **Given** a task that passes validation, **Then** the changes are committed with a message referencing the task ID, and the next task begins.

7. **Given** a task that fails validation, **When** retries are available (max 3), **Then** the error message with line number and relevant code context is fed back to the local model for another attempt, with slightly increased temperature on each retry.

8. **Given** a task that fails all 3 retries, **When** escalation triggers, **Then** Opus first receives a hint request (task + error, ~500 tokens) and the hints are fed back to the local model for one more attempt. If that fails, Opus implements the fix directly.

9. **Given** all tasks are complete, **When** the final review phase runs, **Then** Opus reviews the full diff against the original spec and reports a verdict (pass, pass with notes, or fail) with specific findings.

10. **Given** the workflow completes, **Then** a summary is displayed showing: total tasks, tasks completed by local model, tasks escalated to Opus, total time, and estimated cost savings.

---

### User Story 2 - Standalone Spec Generation (Priority: P2)

A developer wants Opus-quality specifications without running the full implementation pipeline. They run `tiny-spec spec "add rate limiting"` and get a complete spec, plan, and task list that they can use manually with any AI tool (Claude Code, Cursor, Aider, etc.).

**Why this priority**: Many users will start here to evaluate tiny-spec's planning quality before trusting the automated implementation. Also useful for teams where one person specs and another implements.

**Independent Test**: Can be tested by running `tiny-spec spec "add a REST endpoint"` and verifying that spec.md, plan.md, and tasks.md are generated with proper structure, testable requirements, and atomic task definitions.

**Acceptance Scenarios**:

1. **Given** a project directory, **When** the user runs `tiny-spec spec "add rate limiting"`, **Then** Opus researches the codebase and generates `.tiny-spec/current/spec.md` with user scenarios, functional requirements, and success criteria.

2. **Given** a generated spec, **When** the user approves it (or uses `--auto`), **Then** Opus generates `.tiny-spec/current/plan.md` with architecture decisions and `.tiny-spec/current/tasks.md` with atomic implementation tasks.

3. **Given** generated spec artifacts, **When** the user inspects tasks.md, **Then** each task is self-contained with inlined code context, function signatures, test expectations, and constraints -- usable independently with any AI coding tool.

---

### User Story 3 - Configuration and Model Setup (Priority: P3)

A developer configures which local model to use and where it runs. The tool auto-detects available models and creates a sensible default configuration.

**Why this priority**: First-run experience. Without proper configuration, the tool cannot connect to the local model. But this is lower priority because sensible defaults should handle most cases.

**Independent Test**: Can be tested by running `tiny-spec init` with Ollama running and verifying that the config file is created with the correct model and provider auto-detected.

**Acceptance Scenarios**:

1. **Given** first run with no config, **When** the user runs `tiny-spec init`, **Then** the tool checks for running Ollama and LM Studio instances, lists available models, and lets the user select one (or auto-selects the best coding model).

2. **Given** a config file exists, **When** the user wants to change the implementer model, **Then** they can edit the config file or use `tiny-spec init --reconfigure`.

3. **Given** a config file specifying Ollama as provider, **When** the tool starts, **Then** it verifies the model is available and the context window is properly configured (not the 2048-token default).

4. **Given** a config file specifying a cloud API provider (DeepSeek, OpenRouter), **When** the tool starts, **Then** it verifies the API key is set and the endpoint is reachable.

---

### User Story 4 - Resume Interrupted Workflow (Priority: P3)

A developer's session is interrupted (Ctrl+C, crash, laptop sleep). They want to resume from where they left off without re-running completed tasks.

**Why this priority**: Workflows can take 10-30 minutes. Losing progress is frustrating. But this is P3 because it's an edge case that can be worked around by restarting.

**Independent Test**: Can be tested by starting a workflow, interrupting it mid-task, then running `tiny-spec resume` and verifying it continues from the correct task.

**Acceptance Scenarios**:

1. **Given** a workflow interrupted during task 5 of 12, **When** the user runs `tiny-spec resume`, **Then** the tool loads saved state and continues from task 5.

2. **Given** a workflow interrupted during the planning phase, **When** the user runs `tiny-spec resume`, **Then** the tool restarts the planning phase from scratch (planning is not resumable mid-stream).

3. **Given** no interrupted workflow exists, **When** the user runs `tiny-spec resume`, **Then** the tool displays a clear message that there is nothing to resume.

---

### Edge Cases

- What happens when the Opus API returns a rate limit error during planning? The system retries with exponential backoff (max 3 retries, then fails gracefully with saved state).
- What happens when Ollama is not running or the configured model is not pulled? The system checks connectivity at startup and reports a clear error message before entering the workflow.
- What happens when the local model returns an empty response or garbage? The system treats it as a validation failure and retries with error feedback.
- What happens when the local model's response cannot be parsed (no extractable code)? The system retries with an explicit format reminder in the prompt.
- What happens when `tsc` or the test command is not available in the project? The system skips unavailable validation steps and warns the user.
- What happens when the user presses Ctrl+C during implementation? The system saves current state, discards uncommitted changes from the current task, and exits cleanly.
- What happens when a task depends on a failed task? The system skips dependent tasks and reports them as "skipped due to dependency failure" in the summary.
- What happens when the generated spec/plan is rejected by the user? The system returns to idle state. The user can re-run with a revised description.
- What happens when the user manually edits project files during implementation? The system checks for external changes (via git status) before starting each task. If uncommitted changes are detected that were not made by tiny-spec, the user is warned and asked whether to continue (incorporating changes) or pause the pipeline.

## Clarifications

### Session 2026-03-25

- Q: Should tiny-spec v0.1 support any language or only TypeScript/JavaScript projects? → A: TypeScript/JavaScript projects only in v0.1, multi-language support deferred to v0.2.
- Q: How should tiny-spec communicate with the planner? → A: Claude Code CLI (`claude -p`) as a subprocess, using the user's existing subscription ($0 extra). Output streamed to the left TUI pane so users see Opus working in real-time. Split-pane TUI showing both planner (Claude Code) and implementer (local model streaming + file changes + validation) side by side.
- Q: What happens when the user manually edits files while implementation is running? → A: Detect external changes via git status before each task. Warn the user and ask whether to continue or pause.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept a natural language feature description and generate a specification document with user scenarios, acceptance criteria, and functional requirements.
- **FR-002**: System MUST generate an implementation plan with architecture decisions from the specification.
- **FR-003**: System MUST generate atomic, self-contained implementation tasks from the plan, each containing: task description, target file, action type (create/modify), function signature, inlined code context, test expectations with concrete values, and constraints.
- **FR-004**: System MUST send each task to the configured local model as a self-contained prompt via the OpenAI-compatible API.
- **FR-005**: System MUST parse the local model's response to extract code, handling markdown fences, explanation text, and malformed output.
- **FR-006**: System MUST apply the extracted code to the target file (whole-file replacement for files under 200 lines; search/replace for larger files).
- **FR-007**: System MUST run a validation pipeline after each task: TypeScript typecheck (`tsc --noEmit`), lint (ESLint or Biome), then affected tests -- stopping on first failure. v0.1 targets TypeScript/JavaScript projects only.
- **FR-008**: System MUST retry failed tasks up to 3 times, providing the specific error message, line number, and relevant code context in the retry prompt.
- **FR-009**: System MUST vary the retry approach across attempts (include error feedback on retry 1, rephrase the task on retry 2, increase sampling temperature on retry 3).
- **FR-010**: System MUST escalate tasks that fail all retries using a two-tier approach: first request hints from Opus (~500 tokens), feed hints to local model for one more attempt; if still failing, request full implementation from Opus.
- **FR-011**: System MUST commit changes after each successful task with a message referencing the task ID.
- **FR-012**: System MUST discard uncommitted changes when a task fails all retries and escalation.
- **FR-013**: System MUST perform a final review using Opus that compares the full diff against the original spec and produces a structured verdict.
- **FR-014**: System MUST display a split-pane terminal UI with: left pane showing real-time Claude Code output (planner), right pane showing implementer activity (streaming model response, file changes applied, validation results), and a status bar showing current phase, task progress (X/Y), active model, and retry count.
- **FR-015**: System MUST allow user approval of generated spec and plan before proceeding, with an option to auto-approve via flag.
- **FR-016**: System MUST open generated specs in the user's preferred editor (`$EDITOR` / `$VISUAL`) for review.
- **FR-017**: System MUST persist workflow state to disk after each state transition for resume capability.
- **FR-018**: System MUST auto-detect available local models from running Ollama and LM Studio instances during initialization.
- **FR-019**: System MUST handle the Ollama default context window limitation by explicitly configuring context length based on the user's settings.
- **FR-020**: System MUST support multiple implementation providers (Ollama, LM Studio, DeepSeek, OpenRouter) through a unified API interface.
- **FR-021**: System MUST track and display token usage and estimated cost savings in the workflow summary.
- **FR-022**: System MUST skip tasks whose dependencies have failed, reporting them as "skipped" in the summary.
- **FR-023**: System MUST handle graceful shutdown on SIGINT/SIGTERM by saving state and cleaning up uncommitted changes.
- **FR-024**: System MUST check for external file modifications (via git status) before starting each task. If uncommitted changes not made by tiny-spec are detected, the system warns the user and asks whether to continue or pause.

### Key Entities

- **Feature**: A user-described capability to build. Has a description, generated spec, plan, and task list. Progresses through workflow phases.
- **Task**: An atomic unit of implementation work. Has an ID, title, target file, action type, description, function signature, test expectations, constraints, and status (pending/in_progress/done/failed/escalated/skipped). Contains all context needed for a local model to implement it without external references.
- **Configuration**: User's preferences for the tool. Includes planner settings (model), implementer settings (provider, model, context length), validation settings (which checks to run, test command), and workflow settings (auto-approve, max retries, commit per task).
- **Workflow State**: The current progress of a feature through the pipeline. Includes current phase, current task index, retry count, lists of completed/escalated/skipped tasks, and timestamps.
- **Validation Result**: The outcome of running a validation check. Includes which stage failed (typecheck/lint/test), the error message, and the output.
- **Summary**: End-of-workflow report. Includes total tasks, tasks completed by local model, tasks escalated, tasks skipped, total time, token usage breakdown, and estimated cost savings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users complete a medium-complexity feature (10-15 tasks) end-to-end in under 30 minutes using the automated pipeline.
- **SC-002**: At least 70% of implementation tasks are completed successfully by the local model without escalation to Opus.
- **SC-003**: Users achieve at least 2x effective value from their existing AI subscription (measured by features completed per month vs. baseline).
- **SC-004**: The tool adds less than $3 in API/compute costs per feature when using local models for implementation.
- **SC-005**: Each generated task prompt is self-contained and produces correct code in a standalone test with a 7B coding model at least 50% of the time on first attempt.
- **SC-006**: The tool starts and displays the TUI within 2 seconds of invocation.
- **SC-007**: Workflow state is recoverable after any interruption -- resuming completes the feature without re-doing finished tasks.
- **SC-008**: The validation pipeline catches at least 80% of compilation errors and test failures introduced by local model implementations.

## Assumptions

- User has Claude Code installed and authenticated (Max 5x or higher plan) for the planning phase. The tool spawns `claude -p` as a subprocess -- no separate API key needed.
- User has Ollama, LM Studio, or a cloud API provider (DeepSeek, OpenRouter) configured for the implementation phase.
- User's project is a TypeScript or JavaScript project with a working typecheck/lint/test setup (or at minimum, `.ts`/`.js` files that can be parsed by `tsc`).
- Git is initialized in the project directory.
- The project is small enough that relevant context for any single task fits within the local model's context window (8K-32K tokens).
- Local models (7B-27B) can implement single-function tasks given a detailed, self-contained prompt -- validated by research showing 57-88% HumanEval pass rates and 25%+ improvement with plan-first approaches.
- The two-tier escalation approach (hints first, then full implementation) reduces escalation costs by 30-50% compared to always doing full Opus escalation.

## Out of Scope (v0.1)

- Prain MCP integration for intelligent context assembly (v0.2)
- Parallel task execution via git worktrees (v0.2)
- Spawning OpenCode or Aider as implementer subprocess (v0.2 -- direct API for implementer in v0.1; Claude Code CLI IS used for planning)
- Hashline edit format for token-efficient diffs (v0.2)
- Custom spec/plan/task templates (future)
- Web dashboard / GUI (future)
- Windows support (future)
- MCP server mode (future)
- Multi-language support (v0.2 -- Python, Go, Rust, etc.)
- Multi-project orchestration (future)
