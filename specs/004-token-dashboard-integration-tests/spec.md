# Feature Specification: Pluggable Orchestrator, Token Dashboard & Integration Tests

**Feature Branch**: `004-token-dashboard-integration-tests`
**Created**: 2026-03-26
**Status**: Draft
**Input**: User description: "Universal pluggable orchestrator supporting multiple planner/implementer backends, token usage dashboard with cost savings reporting, and integration tests for full workflow"

## Clarifications

### Session 2026-03-26

- Q: Should the completion summary be a full-screen TUI view or inline text? → A: Full-screen TUI view replacing split-pane layout after completion (Option A), with plain text fallback for piped/--json output.
- Q: Should tiny-spec support only Claude Code as planner? → A: No — pluggable architecture supporting Claude Code, Codex CLI, OpenCode, Aider, and Agent SDK as planner backends. Config-driven provider selection.
- Q: Should tiny-spec support only Ollama as implementer? → A: No — already supports Ollama/LM Studio/DeepSeek/OpenRouter. Extend with Codex --oss and any OpenAI-compatible endpoint.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pluggable Planner Backend (Priority: P1)

Users can configure which AI coding tool serves as the "planner" (the expensive/smart AI that researches the codebase, writes specs, plans, and breaks work into tasks). Instead of hardcoded Claude Code, users choose from multiple backends: Claude Code CLI, Codex CLI, OpenCode, Aider, or the Anthropic Agent SDK. Each backend is invoked through a unified interface, and tiny-spec handles the differences in subprocess management, output parsing, and session continuity.

**Why this priority**: This is the architectural foundation for everything else. Without a planner abstraction, tiny-spec is locked to Claude Code subscribers only. Opening to Codex/OpenCode/Aider users expands the audience from "Claude Max users" to "anyone with access to any AI coding tool."

**Independent Test**: Can be tested by configuring a different planner backend in config.yaml and running `tiny-spec start "add hello world"` — the planning phase should work regardless of which backend is selected.

**Acceptance Scenarios**:

1. **Given** a config with `planner.provider: claude-code`, **When** the user starts a workflow, **Then** Claude Code is spawned as subprocess with `claude -p --output-format stream-json` and planning proceeds as before.
2. **Given** a config with `planner.provider: codex`, **When** the user starts a workflow, **Then** Codex CLI is spawned with appropriate flags and planning output is parsed into spec/plan/tasks.
3. **Given** a config with `planner.provider: aider`, **When** the user starts a workflow, **Then** Aider is spawned in architect mode and planning output is parsed.
4. **Given** a config with an unsupported planner provider, **When** the user starts a workflow, **Then** the system exits with a clear error listing supported providers.
5. **Given** any planner backend, **When** planning completes, **Then** the output is normalized into the same spec.md/plan.md/tasks.md format regardless of which backend produced it.

---

### User Story 2 - Completion Summary Dashboard (Priority: P1)

After a full workflow completes (`tiny-spec start "feature"`), the user sees a rich full-screen summary in the TUI showing exactly how many tokens were consumed across all phases, what each phase cost, and how much money they saved by using local models instead of doing everything with the expensive planner.

**Why this priority**: This is the core value proposition of tiny-spec — users need to *see* their savings to trust the tool. The current summary shows minimal info with incomplete cost data.

**Independent Test**: Can be fully tested by running a complete workflow and verifying the summary screen displays accurate token counts and cost calculations.

**Acceptance Scenarios**:

1. **Given** a completed workflow with 10 tasks (8 local, 2 escalated), **When** the workflow reaches the `complete` phase, **Then** the summary displays total tokens broken down by planner/implementer/escalation, actual cost, hypothetical all-planner cost, and savings percentage.
2. **Given** a completed workflow using only local models (0 escalations), **When** the summary displays, **Then** it shows 100% local completion rate and maximum cost savings.
3. **Given** a completed workflow where all tasks required escalation, **When** the summary displays, **Then** it shows 0% local completion rate and $0 savings.
4. **Given** a workflow that was resumed from a saved state, **When** the summary displays after completion, **Then** token counts include tokens from both the original and resumed sessions.
5. **Given** a non-interactive run (piped output or `--json` flag), **When** the workflow completes, **Then** the summary is output as structured plain text or JSON, not TUI.

---

### User Story 3 - Integration Tests for Full Workflow (Priority: P1)

Developers can run integration tests that verify the complete planner → implementer → validation pipeline works end-to-end. Tests confirm that the planner subprocess spawns correctly, the implementer API responds, code gets applied to files, validation runs, and token tracking accumulates correctly through the entire flow.

**Why this priority**: Equal to P1 because without integration tests, there's no way to verify the tool actually works as a system. Unit tests (132 passing) test individual components but don't catch integration failures — which is where v0.1 bugs came from.

**Independent Test**: Can be tested by running `npm test -- tests/integration/` against a test project with at least one planner and one implementer available.

**Acceptance Scenarios**:

1. **Given** Claude Code is installed, **When** the integration test runs the planner, **Then** it receives valid output with session ID, text content, and usage data.
2. **Given** Ollama is running with a coding model, **When** the integration test sends a code generation task, **Then** it receives a valid completion with extractable code and usage statistics.
3. **Given** a sample TypeScript project, **When** the integration test runs the full workflow (plan → implement → validate), **Then** all tasks complete, commits are made, and token usage is non-zero.
4. **Given** an intentionally failing task, **When** the integration test triggers the retry pipeline, **Then** retries execute up to the configured limit and escalation fires if retries are exhausted.
5. **Given** a workflow is interrupted mid-task, **When** `resume` is called, **Then** the workflow continues from the interrupted task with accumulated token counts preserved.
6. **Given** a planner backend is unavailable, **When** integration tests run, **Then** tests for that backend skip gracefully with a descriptive message.

---

### User Story 4 - Live Token Counter During Execution (Priority: P2)

While the workflow is running, the user can see a running token counter in the status bar showing how many tokens have been consumed so far and the running cost estimate.

**Why this priority**: Real-time feedback during long-running workflows (15-30 min) helps users understand resource consumption as it happens.

**Independent Test**: Can be tested by starting a workflow and observing that the status bar updates token counts after each planner phase and each implementer task.

**Acceptance Scenarios**:

1. **Given** a running workflow in the planning phase, **When** the planner completes a step, **Then** the status bar updates to show accumulated planner tokens.
2. **Given** a running workflow implementing tasks, **When** a task completes, **Then** the status bar updates to show accumulated implementer tokens.
3. **Given** an escalation occurs, **When** the escalation completes, **Then** the escalation token count updates in the status bar.

---

### User Story 5 - Per-Task Token Breakdown (Priority: P3)

Users can see a per-task breakdown showing which tasks were completed locally vs escalated, how many tokens each task consumed, and how many retry attempts were needed.

**Why this priority**: Nice-to-have granularity for power users who want to optimize their prompts or model selection.

**Independent Test**: Can be tested by completing a workflow and verifying each task row in the summary shows its individual token count and completion method.

**Acceptance Scenarios**:

1. **Given** a completed workflow, **When** the summary displays, **Then** each task shows: task name, completion method (local/escalated), token count, and retry attempts.
2. **Given** a task that was escalated after retries, **When** viewing its breakdown, **Then** it shows the total tokens across all retries plus escalation tokens.

---

### Edge Cases

- What happens when a planner backend is not installed? → System exits with error message naming the missing tool and installation instructions.
- What happens when planner output doesn't conform to expected format? → System attempts best-effort parsing; if critical sections (tasks) are missing, aborts with error.
- What happens when switching planner backends mid-workflow (via resume)? → Not supported; system detects mismatch and warns user.
- What happens when Ollama is not running when integration tests start? → Tests skip with a clear message.
- What happens when a provider doesn't return usage data? → Token counts show 0 with no errors.
- What happens when the workflow completes with 0 tasks? → Summary displays "No tasks executed" gracefully.
- What happens when token usage numbers are very large? → Numbers display with K/M suffixes.
- What happens when a resumed workflow has stale token data? → Missing fields initialize to 0.

## Requirements *(mandatory)*

### Functional Requirements

**Pluggable Planner Backend (US1)**

- **FR-001**: System MUST define a planner provider interface with methods for: starting a planning session, streaming output, extracting artifacts (spec/plan/tasks), and reporting token usage.
- **FR-002**: System MUST support Claude Code CLI as a planner backend via `claude -p --output-format stream-json` subprocess.
- **FR-003**: System MUST support Codex CLI as a planner backend via subprocess invocation with appropriate flags for non-interactive planning.
- **FR-004**: System MUST support Aider as a planner backend via subprocess invocation in architect mode.
- **FR-005**: System MUST support OpenCode as a planner backend via subprocess or API invocation.
- **FR-006**: System MUST support the Anthropic Agent SDK as a planner backend via the `@anthropic-ai/claude-agent-sdk` package.
- **FR-007**: System MUST normalize output from all planner backends into a consistent spec.md/plan.md/tasks.md format.
- **FR-008**: System MUST detect whether the configured planner is installed and available at startup, and exit with a helpful error if not.
- **FR-009**: System MUST allow planner provider selection via config.yaml (`planner.provider` field).
- **FR-010**: System MUST pass through planner output to the left TUI pane regardless of which backend is active.

**Token Usage Dashboard (US2)**

- **FR-011**: System MUST display a full-screen completion summary after workflow finishes showing: total planner tokens (input/output), total implementer tokens (input/output), total escalation tokens (input/output).
- **FR-012**: System MUST calculate and display the hypothetical cost if all implementation had been done by the planner, using the planner's token pricing.
- **FR-013**: System MUST calculate and display the actual cost incurred (planning + escalation at planner rates, implementer at provider rates or $0 for local).
- **FR-014**: System MUST display the cost savings as both a dollar amount and a percentage.
- **FR-015**: System MUST display the local completion rate (tasks completed without escalation / total tasks) as a percentage.
- **FR-016**: System MUST display total workflow duration formatted as hours/minutes/seconds.
- **FR-017**: System MUST display the planner and implementer provider/model names.
- **FR-018**: System MUST fall back to plain text or JSON summary output when not running in interactive TUI mode.

**Integration Tests (US3)**

- **FR-019**: System MUST include an integration test that verifies the Claude Code planner spawns, returns structured output, and extracts usage data.
- **FR-020**: System MUST include an integration test that verifies Ollama connectivity, sends a code generation prompt, and receives a valid completion with usage stats.
- **FR-021**: System MUST include an integration test that runs the validation pipeline (typecheck → lint → tests) against a sample project fixture.
- **FR-022**: System MUST include an integration test that verifies token accumulation — tokens from planner, implementer, and escalation must aggregate correctly in state.
- **FR-023**: System MUST include an integration test that verifies the retry pipeline — a failing task triggers retries up to the configured limit.
- **FR-024**: System MUST include an integration test that verifies workflow resume — interrupted workflow resumes from correct task with token counts preserved.
- **FR-025**: Integration tests that require external services MUST skip gracefully with a descriptive message when the service is unavailable.
- **FR-026**: System MUST provide a sample TypeScript project fixture for integration tests.

**Live Token Counter (US4)**

- **FR-027**: System MUST update token counts in the status bar after each planner phase completes.
- **FR-028**: System MUST update token counts in the status bar after each implementer task completes (including retries).
- **FR-029**: System MUST display a running cost estimate in the status bar based on accumulated tokens.

**Per-Task Breakdown (US5)**

- **FR-030**: System MUST track per-task token usage (implementer tokens + any escalation tokens for that task).
- **FR-031**: System MUST display a task-by-task breakdown in the completion summary showing task name, completion method, token count, and retry attempts.

**Cross-Cutting**

- **FR-032**: System MUST persist token usage data to events.jsonl with enough granularity to reconstruct per-task and per-phase breakdowns.
- **FR-033**: System MUST format large token numbers with K/M suffixes for readability.
- **FR-034**: System MUST handle providers that don't return usage data gracefully — display 0 tokens with no errors.
- **FR-035**: System MUST maintain a pricing table for known planner/implementer providers, updatable in a single location.

### Key Entities

- **PlannerProvider**: Abstraction over planner backends — defines interface for starting sessions, streaming output, extracting artifacts, and reporting usage. Implementations: claude-code, codex, aider, opencode, agent-sdk.
- **ImplementerProvider**: Already partially exists (providers.ts) — abstraction over implementer backends with baseURL/apiKey/model config.
- **TokenUsage**: Aggregate token counts across six dimensions (plannerInput/Output, implementerInput/Output, escalationInput/Output).
- **TaskTokenUsage**: Per-task token tracking — links a task identifier to its implementer tokens, retry tokens, and escalation tokens.
- **CostBreakdown**: Computed entity — hypothetical all-planner cost, actual cost, savings amount, savings percentage, local completion rate.
- **PricingTable**: Per-provider token pricing (input/output rates per million tokens). $0 for local providers.
- **IntegrationTestFixture**: A minimal TypeScript project with source files, tests, and configuration used by integration tests.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can switch planner backend by changing one config field and the workflow completes successfully.
- **SC-002**: Users see accurate token counts within 5% of actual usage reported by providers after workflow completion.
- **SC-003**: Cost savings percentage is displayed and matches the formula: `(hypothetical_planner_cost - actual_cost) / hypothetical_planner_cost × 100`.
- **SC-004**: Integration tests achieve 90%+ pass rate when required services are available.
- **SC-005**: Integration tests complete in under 5 minutes for a 3-task sample project.
- **SC-006**: Live token counter updates within 2 seconds of each phase/task completion.
- **SC-007**: Completion summary renders in under 1 second after workflow finishes.
- **SC-008**: Token data persists correctly across workflow resume — no data loss on interrupt/resume cycle.
- **SC-009**: At least 2 planner backends (Claude Code + one other) work end-to-end in integration tests.

## Assumptions

- Users have at least one planner backend installed and configured (Claude Code, Codex, OpenCode, or Aider).
- Users have at least one implementer available (Ollama, LM Studio, or a cloud provider API key).
- Each planner backend has a non-interactive/pipe mode suitable for subprocess invocation.
- Planner output can be normalized into spec.md/plan.md/tasks.md format regardless of backend — the prompt templates guide the output structure.
- Token pricing for cloud providers is maintained as a static lookup table, not queried dynamically.
- Local model inference (Ollama, LM Studio) is treated as $0 cost.
- Integration tests that require specific backends skip gracefully when those backends are unavailable.
- The sample project fixture is a minimal TypeScript project (3-5 files) checked into `tests/fixtures/`.
- Planner backends may have different capabilities (e.g., Aider doesn't support session continuity the same way Claude Code does) — the abstraction accommodates these differences.
