# Feature Specification: diptych v0.2  -  Critical Fixes, Robustness & Core Value Delivery

**Feature Branch**: `003-v02-fixes-robustness`
**Created**: 2026-03-25
**Status**: Draft
**Input**: Fix all critical bugs, high-severity security/functional issues, deliver working cost savings display, expand test coverage, modernize build tooling, and improve code quality identified by comprehensive 21-agent deep analysis of v0.1.

## User Scenarios & Testing *(mandatory)*

### User Story 1  -  Resume Interrupted Workflow (Priority: P1)

A developer's workflow was interrupted mid-implementation (e.g., laptop closed, network drop, Ctrl+C). They run `diptych resume` and the tool picks up exactly where it left off  -  at the correct task, with all previously completed tasks preserved, without re-running planning or re-implementing already-done tasks.

**Why this priority**: Resume is a core workflow promise (US4 from v0.1 spec). Currently completely broken  -  the command loads saved state but discards it, restarting from scratch. This is the most visible user-facing bug.

**Independent Test**: Run `diptych start "feature"`, interrupt after task 3 of 10 completes, run `diptych resume`, verify it continues from task 4 with tasks 1-3 marked complete.

**Acceptance Scenarios**:

1. **Given** a workflow interrupted during task 5 of 12, **When** user runs `diptych resume`, **Then** the tool loads saved state, displays tasks 1-4 as complete, and begins executing task 5.
2. **Given** a workflow interrupted during validation of task 3, **When** user runs `diptych resume`, **Then** the tool resumes from the `validating-task` phase for task 3 with retry counter preserved.
3. **Given** a workflow interrupted during escalation, **When** user runs `diptych resume`, **Then** the tool resumes from the `escalating` phase and continues the appropriate escalation tier.
4. **Given** no saved workflow state exists, **When** user runs `diptych resume`, **Then** the tool displays "Nothing to resume" and exits cleanly.
5. **Given** a workflow interrupted during planning phases (research/specifying/planning), **When** user runs `diptych resume`, **Then** the tool reports that planning phases are not resumable and suggests re-running `diptych start`.

---

### User Story 2  -  Reliable Retry and Escalation (Priority: P1)

A developer runs `diptych start "feature"`. When a local model fails a task, the tool retries up to the configured number of times (not a hardcoded value), varying its approach each time. If all retries fail, it escalates correctly  -  first with hints, then with full Opus implementation. After escalation, the next task starts fresh with a reset retry counter. The escalation subprocess runs in the correct project directory and parses Claude's output correctly.

**Why this priority**: The retry/escalation pipeline is the core differentiator. Three interrelated bugs (hardcoded MAX_RETRIES, stale attempt counter, wrong escalator stream parser + missing cwd) undermine its reliability.

**Independent Test**: Configure `maxRetries: 5` in config, provide a task that always fails, verify 5 retries occur before escalation. Then verify the next task after escalation gets its full retry budget.

**Acceptance Scenarios**:

1. **Given** `maxRetries` is set to 5 in config, **When** a task fails validation, **Then** the tool retries exactly 5 times before escalating (not 3).
2. **Given** a task was escalated via tier-2 (full Opus), **When** the next task begins, **Then** the retry counter starts at 0, giving the task its full retry budget.
3. **Given** a task fails all retries and escalates, **When** tier-1 hints are generated, **Then** the escalator runs Claude in the correct project directory with proper stream-json parsing.
4. **Given** a task fails all retries, **When** tier-2 full implementation runs, **Then** Claude's output is correctly parsed using the CLI's `assistant`/`result` event format (not the Anthropic API format).
5. **Given** the retry counter is at the maximum, **When** `VALIDATION_FAIL` is dispatched to the state machine, **Then** the state transitions to `escalating` (not a silent no-op).

---

### User Story 3  -  Cost Savings Visibility (Priority: P1)

A developer completes a workflow and sees an accurate summary of token usage and estimated cost savings. The summary shows how many tokens were consumed by the planner (Opus), the implementer (local model), and escalation, along with the estimated dollar savings compared to using Opus for everything.

**Why this priority**: This is the tool's primary value proposition ("save 50%+ on AI coding costs"). Currently always shows `$0.00` because token counters are never populated.

**Independent Test**: Run a workflow with at least one task, verify the summary displays non-zero token counts and a positive cost savings estimate.

**Acceptance Scenarios**:

1. **Given** a workflow completes with 10 tasks, **When** the summary is displayed, **Then** planner token usage (input/output) reflects actual Claude CLI consumption.
2. **Given** a workflow completes, **When** the summary is displayed, **Then** implementer token usage reflects actual local model API consumption.
3. **Given** 2 of 10 tasks were escalated, **When** the summary is displayed, **Then** escalation token usage reflects the Claude CLI tokens consumed for hints and full implementations.
4. **Given** all token counts are populated, **When** cost savings is calculated, **Then** the display shows the difference between "all-Opus cost" and "actual cost (Opus planning + free local + Opus escalation only)" as a dollar amount and percentage.
5. **Given** a workflow completes, **When** elapsed time is displayed, **Then** it shows correctly formatted time (e.g., "45s" or "3m 12s"), not raw milliseconds.

---

### User Story 4  -  Safe File Operations (Priority: P1)

A developer runs `diptych start` on their project. The tool writes code only within the project directory  -  never to paths outside it. When tasks fail and changes are discarded, only files created or modified by diptych are affected, preserving the developer's other untracked work. When the developer presses Ctrl+C, all subprocesses are properly terminated and the working directory is left in a clean state.

**Why this priority**: Security and data integrity are non-negotiable. Path traversal allows writing to arbitrary files. `git clean -f -d` destroys all untracked files. Orphaned subprocesses and incomplete cleanup on SIGINT leave the system in an inconsistent state.

**Independent Test**: Create a task with `file: "../../outside-project/evil.ts"`, verify the tool rejects it. Create untracked files in the project, trigger a task failure + discard, verify untracked files survive.

**Acceptance Scenarios**:

1. **Given** a task specifies a file path that resolves outside the project directory (e.g., `../../etc/something`), **When** the tool attempts to write code, **Then** it rejects the path with a clear error and skips the task.
2. **Given** untracked files exist in the project, **When** a task fails and changes are discarded, **Then** only files modified by the current task are reverted  -  untracked files are preserved.
3. **Given** subprocesses are running (Claude CLI, validation commands), **When** the user presses Ctrl+C, **Then** all tracked and untracked subprocesses are terminated and the process exits cleanly.
4. **Given** the user presses Ctrl+C during implementation, **When** cleanup runs, **Then** uncommitted changes from the in-progress task are properly reverted before exit.
5. **Given** a task file path is passed to lint/test commands, **When** the path contains special characters or flag-like prefixes (e.g., `--config`), **Then** argument injection is prevented (e.g., via `--` separator).

---

### User Story 5  -  Robust Prompt Construction (Priority: P2)

A developer works on a project with large source files (500+ lines). When the tool builds prompts for the local model, it respects the model's context window  -  truncating or summarizing content to fit within configured limits. Retry prompts don't double the content, and the model receives the prompt as a proper system + user message pair.

**Why this priority**: Without prompt size enforcement, large modify tasks produce garbage output because the prompt overflows the model's context window. This is the #1 cause of unnecessary escalations.

**Independent Test**: Configure a model with 8K context, provide a modify task on a 1000-line file, verify the prompt is truncated to fit and the task succeeds or fails gracefully (not with corrupted output).

**Acceptance Scenarios**:

1. **Given** a model with 8K context and a modify task on a 500-line file, **When** the prompt is assembled, **Then** total prompt tokens stay within the model's context limit.
2. **Given** a retry attempt, **When** the retry prompt is built, **Then** it does not duplicate the full original prompt, keeping total size manageable.
3. **Given** the configured `contextLength` from config, **When** `detectCapabilities()` runs at startup, **Then** it updates the config with the actual model context length (queried from the provider).
4. **Given** prompt assembly, **When** the implementer sends the request, **Then** `max_tokens` is set based on the remaining context budget after the prompt.

---

### User Story 6  -  Validated Configuration (Priority: P2)

A developer creates or edits `.diptych/config.yaml`. Invalid values (wrong types, unknown providers, out-of-range numbers) are caught at load time with clear error messages, not at runtime deep in the workflow. The `init --reconfigure` command produces correctly formatted YAML.

**Why this priority**: Currently zero config validation exists  -  malformed YAML silently propagates until it causes cryptic runtime errors.

**Independent Test**: Create a config with `max_retries: "banana"` and `provider: "fakeprovider"`, run `diptych start`, verify clear error messages listing all invalid fields.

**Acceptance Scenarios**:

1. **Given** a config with `provider: "nonexistent"`, **When** the config is loaded, **Then** the tool reports "Invalid provider" with valid options listed and exits with code 2.
2. **Given** a config with `temperature: "warm"`, **When** the config is loaded, **Then** the tool reports a type error for the temperature field.
3. **Given** a config with `maxRetries: -1`, **When** the config is loaded, **Then** the tool reports that maxRetries must be a positive integer.
4. **Given** the user runs `diptych init --reconfigure`, **When** the config file is written, **Then** it uses snake_case keys (e.g., `api_base`, `context_length`) consistent with the standard format.
5. **Given** a cloud provider (deepseek/openrouter) is configured, **When** the required API key environment variable is not set, **Then** the tool warns at startup (not after planning completes).

---

### User Story 7  -  Comprehensive Test Coverage (Priority: P2)

The test suite covers at least 70% of the codebase's logical lines, including the orchestration layer, config loading, validation pipeline, and all pure helper functions. Tests catch regressions in retry logic, state transitions, prompt assembly, and code extraction.

**Why this priority**: Current coverage is ~25% (only pure-logic modules). The entire orchestration layer  -  the most complex and bug-prone code  -  is untested.

**Independent Test**: Run the test suite and verify all tests pass with coverage at ≥70% of logical lines.

**Acceptance Scenarios**:

1. **Given** the test suite, **When** it runs, **Then** it covers the orchestrator's retry/escalation flow (via mocked dependencies).
2. **Given** the test suite, **When** it runs, **Then** it covers config loading, validation, and error cases (malformed YAML, missing fields, wrong types).
3. **Given** the test suite, **When** it runs, **Then** it covers all 20 state machine transitions including the 4 currently untested ones (REJECT_PLAN, HINT_FAIL, FULL_SUCCESS, SET_SESSION_ID).
4. **Given** the test suite, **When** it runs, **Then** it covers the validation pipeline (typecheck, lint, test stages) with mocked subprocess calls.
5. **Given** the test suite, **When** it runs, **Then** it covers `applyCode()` including path traversal rejection, search/replace logic, and file creation.
6. **Given** the test suite, **When** it runs, **Then** previously passing tests (59 tests from v0.1) continue to pass.

---

### User Story 8  -  Modernized Build and Clean Codebase (Priority: P3)

The project uses current versions of its key dependencies, has no dead code, no duplicated logic, and follows consistent type-safe patterns. The build configuration is optimized for the latest runtime with the strictest practical type checking.

**Why this priority**: Technical debt reduction. Not user-facing but improves maintainability, catches bugs at compile time, and keeps the project attractive for contributors.

**Independent Test**: Run the build with zero errors. Run all tests passing. Verify no dead exports via static analysis.

**Acceptance Scenarios**:

1. **Given** the codebase, **When** built with the updated compiler settings, **Then** stricter index-access checks and switch-fallthrough checks are enabled and the build succeeds with zero errors.
2. **Given** three separate stream-parsing implementations exist, **When** the refactor is complete, **Then** a single shared implementation handles all stream-json parsing.
3. **Given** dead code exists (unused exports, unused imports), **When** cleanup is complete, **Then** all dead exports are removed and all unused imports are eliminated.
4. **Given** a UI component library dependency is declared but never imported, **When** cleanup is complete, **Then** it is either removed or its components are actually used in the TUI.
5. **Given** the validate-and-commit pattern is duplicated 4 times in the orchestrator, **When** the refactor is complete, **Then** a single helper function handles the validate-commit-transition flow.
6. **Given** `catch (err: any)` is used in 8 places, **When** the cleanup is complete, **Then** all catch clauses use `unknown` with proper type narrowing.

---

### Edge Cases

- What happens when the saved state file (`state.json`) is corrupted or from an incompatible version? → The tool detects corruption via schema validation, reports the error, and suggests starting a new workflow.
- What happens when Ollama is not running and the workflow starts? → The tool detects the connection failure at startup and reports a clear error with setup instructions.
- What happens when the Claude CLI is not installed or not authenticated? → The tool checks for the `claude` binary at startup and reports the error before entering the planning phase.
- What happens when two `diptych` processes run simultaneously in the same project directory? → The tool uses a lock file in `.diptych/` to prevent concurrent execution, reporting "Another diptych instance is running" if the lock exists.
- What happens when a task's `depends_on` references a bare value without brackets (e.g., `depends_on: T001`)? → The parser handles bare values as single-element dependency lists rather than silently dropping them.
- What happens when the model's streaming response exceeds reasonable memory limits? → The streaming buffer is capped, and excessively long responses are truncated with a warning.
- What happens when `tsc --noEmit` takes longer than the configured timeout on a large project? → The timeout is configurable and defaults to a value appropriate for medium-sized projects, with a clear error when exceeded.
- What happens when `commitPerTask` is set to `false` and external change detection runs? → External change detection is aware of diptych's own uncommitted changes and does not flag them as external.

## Requirements *(mandatory)*

### Functional Requirements

**Critical Bug Fixes:**

- **FR-001**: System MUST resume interrupted workflows from the exact task and phase where they were interrupted, preserving all completed tasks, retry counters, and escalation state.
- **FR-002**: System MUST read `maxRetries` from user configuration for both the retry loop and the state machine transition guard (no hardcoded constant).
- **FR-003**: System MUST reset the `attempt` counter to 0 after any escalation outcome (HINT_SUCCESS, FULL_SUCCESS, FULL_FAIL) so the next task gets its full retry budget.

**Security:**

- **FR-004**: System MUST validate that all task file paths resolve within the project directory before any read or write operation, rejecting paths that escape the project root.
- **FR-005**: System MUST prevent argument injection when passing task file paths to external commands (linters, test runners) by using appropriate argument separators.
- **FR-006**: System MUST properly clean up all streaming timeouts to prevent unhandled promise rejections.

**Process Management:**

- **FR-007**: System MUST track all spawned subprocesses (including escalator and final review) in a central registry so they can be terminated on shutdown.
- **FR-008**: System MUST complete file cleanup operations before process exit on SIGINT/SIGTERM.
- **FR-009**: System MUST scope file discard operations to only files modified by the current task, preserving untracked user files.
- **FR-010**: System MUST handle spawn errors on all subprocesses, rejecting the associated promise rather than hanging indefinitely.
- **FR-011**: System MUST catch and handle the workflow promise in the TUI layer to prevent unhandled rejections.

**Token Tracking & Cost Display:**

- **FR-012**: System MUST capture token usage from planner subprocess output events and accumulate into workflow state.
- **FR-013**: System MUST capture token usage from implementer API responses and accumulate into workflow state.
- **FR-014**: System MUST display accurate cost savings in the workflow summary, comparing actual spend against all-Opus baseline.
- **FR-015**: System MUST display elapsed time correctly formatted (seconds/minutes), not raw milliseconds.

**Escalator Fixes:**

- **FR-016**: System MUST parse escalator subprocess output using the same event format as the planner.
- **FR-017**: System MUST set the working directory to the project directory when spawning subprocesses for escalation.

**Prompt & Model Configuration:**

- **FR-018**: System MUST enforce prompt size limits based on the configured model context length, truncating content to fit.
- **FR-019**: System MUST query the actual model context length from the provider at startup and use it for prompt budgeting.
- **FR-020**: System MUST set output token limits in API requests based on remaining context budget.

**Configuration:**

- **FR-021**: System MUST validate configuration at load time, reporting all invalid fields with clear error messages and exiting with a configuration error code.
- **FR-022**: System MUST write consistent key formats when generating config files via any command path.
- **FR-023**: System MUST validate required credentials at startup, warning if required keys are not set for the configured provider.

**Startup & Concurrency:**

- **FR-024**: System MUST use a lock file to prevent concurrent execution in the same project directory, reporting a clear error if another instance is running.
- **FR-025**: System MUST verify external dependencies (Claude CLI binary, model provider connectivity) at startup before entering the workflow, reporting clear errors with setup instructions.

**Prompt Quality:**

- **FR-026**: System MUST avoid duplicating the full original prompt in retry attempts, keeping retry prompt size manageable relative to the model's context window.
- **FR-027**: System MUST send the system preamble as a proper `system` role message, separate from the `user` role task prompt.

**TUI & Memory:**

- **FR-028**: System MUST cap the output buffer for display panes to prevent unbounded memory growth.

**Test Coverage:**

- **FR-029**: System MUST have test coverage for the orchestrator retry/escalation flow, config validation, all state transitions, the validation pipeline, and file path safety.

**Code Quality:**

- **FR-030**: System MUST use a single shared implementation for subprocess output parsing across all modules.
- **FR-031**: System MUST remove all dead exports and unused imports.
- **FR-032**: System MUST use strict error typing in catch clauses with proper type narrowing.

### Key Entities

- **WorkflowState**: The persisted snapshot of workflow progress  -  phase, current task index, completed/failed/skipped tasks, token usage, retry attempt counter, session ID. Must include a version field for forward compatibility.
- **TokenUsage**: Accumulated token counts across planner (input/output), implementer (input/output), and escalation (input/output). Populated from actual API/subprocess responses.
- **Config**: User-configurable settings  -  provider, model, context length, temperature, retries, validation toggles, approval modes. Validated at load time against a schema.
- **ValidationResult**: Outcome of a single validation stage (typecheck/lint/test)  -  passed, stage name, error output. Error output is sanitized and truncated.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `diptych resume` correctly continues from the interrupted task in 100% of tested interruption points (mid-task, mid-validation, mid-escalation).
- **SC-002**: Cost savings displayed in the workflow summary reflects actual token consumption with less than 10% deviation from true API usage.
- **SC-003**: No file writes occur outside the project directory boundary under any task input, including adversarial paths.
- **SC-004**: All subprocesses are terminated within 5 seconds of Ctrl+C, with no orphaned processes remaining.
- **SC-005**: Test suite covers ≥70% of logical source lines and passes in under 30 seconds.
- **SC-006**: Configuration errors are reported at startup with actionable messages  -  zero config-related runtime crashes during workflow execution.
- **SC-007**: The tool handles projects with files up to 1000 lines without prompt overflow, producing valid model output or graceful truncation.
- **SC-008**: All 59 existing v0.1 tests continue to pass (no regressions).
- **SC-009**: The build completes with zero errors under the stricter compiler settings.
- **SC-010**: Memory usage for TUI output remains bounded (under 50MB) even for workflows with 50+ tasks producing verbose output.

## Assumptions

- Users have Claude Code CLI installed and authenticated (Max plan or higher).
- Users have a local model running via Ollama or LM Studio, or API keys for cloud providers.
- The project is a Git repository with Node.js 22+ and npm available.
- The Claude CLI subprocess emits structured JSON events including token usage data in result events.
- The OpenAI-compatible API returns usage information in streaming responses when requested.
- Dependency upgrades (TypeScript, OpenAI SDK, Commander) are stable with documented migration paths.
- The v0.1 spec and plan documents remain valid references for feature intent  -  this spec extends but does not replace them.
- Token pricing for the planner model may change; the tool should make pricing configurable or fetch it dynamically in a future version.
