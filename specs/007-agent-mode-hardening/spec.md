# Feature Specification: Agent-Mode Implementer & Workflow Hardening

**Feature Branch**: `007-agent-mode-hardening`
**Created**: 2026-03-26
**Status**: Draft
**Input**: User description: "Agent-mode implementer, battle-test conversational TUI, and CLI version detection (from docs/NEXT.md)"

## User Scenarios & Testing

### User Story 1 - Agent-Mode Implementer (Priority: P1)

A developer wants to use a full coding agent (e.g., Claude Code with alternative models, Aider, Codex CLI) as the implementer instead of a simple chat API. They set their implementer type to "agent" in the project config and specify the command to run. When tiny-spec reaches the implementation phase, it sends the task description to the agent tool, the agent writes files directly to the project, and tiny-spec validates (typecheck, lint, test), retries if validation fails, escalates to the planner if retries are exhausted, and commits on success.

The key value: tiny-spec's validation/retry/escalation/commit pipeline still applies, providing quality assurance that running the agent standalone wouldn't have. The planner/implementer cost split is preserved — planning uses expensive AI, implementation uses whatever the user configures.

**Why this priority**: This is an architectural decision that blocks other work. The current shell implementer assumes tiny-spec controls file writes, which conflicts with agent-style tools that manage their own files. Resolving this determines the project's direction.

**Independent Test**: Can be fully tested by configuring an agent-style tool as implementer and running a multi-task workflow. Delivers value by enabling users to plug in any coding agent while retaining tiny-spec's quality pipeline.

**Acceptance Scenarios**:

1. **Given** a config with implementer type set to "agent" and a valid command, **When** the user starts a workflow, **Then** the system sends each task description to the agent command, waits for it to complete, and validates the resulting file changes.
2. **Given** an agent-mode implementer that produces code failing validation, **When** validation fails, **Then** the system retries the task (sending the error context to the agent) up to the configured maximum, then escalates to the planner.
3. **Given** an agent-mode implementer, **When** a task completes and passes validation, **Then** the system commits the changes with the same commit format as API-mode tasks.
4. **Given** an agent-mode implementer that is a shell function (not on PATH), **When** the system attempts to start it, **Then** the system resolves the function through the user's shell and starts it, or shows a clear error explaining why it cannot.
5. **Given** an agent-mode implementer that hangs or crashes, **When** the configured timeout elapses, **Then** the system terminates the process and treats it as a task failure (entering retry flow).

---

### User Story 2 - Reliable Conversational Planning (Priority: P2)

A developer starts a feature workflow. During the research and specification phases, the planner identifies aspects that need clarification and asks questions. The developer sees the questions in the TUI, selects from suggested options or types a custom answer, and the planner incorporates the answers into the specification. After the spec is generated, the developer can approve it, open it in their editor, comment to request changes (triggering the planner to regenerate), or quit. This entire flow works reliably from start to finish without crashes, hangs, or data loss.

**Why this priority**: The conversational planning flow was implemented in one pass by AI agents and has not been tested end-to-end with real planner and implementer tools. It needs hardening before users can rely on it.

**Independent Test**: Can be tested by running the full start command with a real planner and verifying that questions appear, answers are captured, the spec incorporates them, and the approval/comment/regeneration cycle works.

**Acceptance Scenarios**:

1. **Given** a planner that emits clarification questions during research, **When** questions are detected in the planner's output stream, **Then** the TUI displays them with selectable options and accepts the user's answers.
2. **Given** clarification answers provided by the user, **When** the planner generates the specification, **Then** the answers are reflected in the spec content and persisted to the spec file.
3. **Given** a generated spec that the user wants to modify, **When** the user selects "comment" at the approval prompt and types feedback, **Then** the planner regenerates the relevant sections incorporating the feedback (for planners that support session continuity).
4. **Given** a planner backend that does not support session continuity, **When** the user selects "comment", **Then** the system informs the user that commenting requires session continuity and offers alternative actions (approve, edit, quit).
5. **Given** a planner that emits malformed or incomplete question markers, **When** the system attempts to parse them, **Then** the system skips the malformed questions without crashing and continues the workflow.
6. **Given** a user who interrupts (Ctrl+C) during the question-answering flow, **When** the interrupt is received, **Then** the system exits gracefully without corrupting state files or leaving orphan processes.

---

### User Story 3 - Planner Version Detection (Priority: P3)

When tiny-spec starts a workflow, it detects the version of the configured planner tool (e.g., by running the tool's version command). Based on the detected version, it adjusts command-line flags and output parsing behavior to match what that version expects. If the version is unrecognized or the tool's behavior has changed, the user sees a clear, actionable error message explaining what happened and suggesting a resolution.

**Why this priority**: The planner CLI API is a moving target (e.g., Claude Code changed flag requirements between versions). Without version detection, users hit cryptic errors when their CLI version doesn't match the expected flags.

**Independent Test**: Can be tested by running the start command with different planner CLI versions and verifying correct flag selection and clear error messages for unsupported versions.

**Acceptance Scenarios**:

1. **Given** a recognized planner CLI version is installed, **When** the workflow starts, **Then** the system detects the version and uses the correct flags for that version.
2. **Given** an unrecognized planner CLI version, **When** the workflow starts, **Then** the system shows a warning with the detected version number and falls back to the latest known flag set.
3. **Given** the planner CLI is not installed or not on PATH, **When** the workflow starts, **Then** the system shows an actionable error message explaining what's missing and how to install it.
4. **Given** the planner CLI returns unexpected output format despite correct flags, **When** parsing fails, **Then** the system shows the raw error and the detected version, helping the user diagnose the mismatch.

---

### Edge Cases

- Agent-mode implementer writes no files (misunderstood the task or produced only commentary)
- Agent-mode implementer modifies files outside the task's declared scope
- Agent-mode implementer process exits with a non-zero code but has written valid files
- Multiple tasks target the same file in sequence — agent mode must not leave stale state between tasks
- Planner emits question markers split across multiple stream chunks
- User provides empty answers to clarification questions
- Planner CLI version changes between workflow start and resume (user updated the tool mid-workflow)
- Network interruption during planner streaming (question markers partially received)
- Config specifies agent mode but the command field is missing or empty
- Agent-mode implementer creates new files not declared in the task — should validation include them?

## Requirements

### Functional Requirements

**Agent-Mode Implementer**

- **FR-001**: System MUST support an "agent" implementer mode in addition to the existing "api" and "shell" modes
- **FR-002**: In agent mode, the system MUST send the task description to the configured command and wait for it to exit
- **FR-003**: In agent mode, the system MUST NOT extract code from the implementer's output or write files on its behalf — the implementer is trusted to write files directly
- **FR-004**: In agent mode, the system MUST run the full validation pipeline (typecheck, lint, test) after the implementer exits for each task
- **FR-005**: In agent mode, the system MUST retry failed tasks by re-invoking the implementer with the validation error context, up to the configured maximum retries
- **FR-006**: In agent mode, the system MUST escalate to the planner when retries are exhausted, following the same two-tier escalation as API mode (hints first, then full implementation)
- **FR-007**: In agent mode, the system MUST commit validated changes after each successful task
- **FR-008**: System MUST resolve the implementer command through the user's login shell when the command is not found on PATH directly (to support shell functions and aliases)
- **FR-009**: System MUST enforce a configurable timeout for agent-mode implementer processes and treat timeouts as task failures
- **FR-010**: System MUST detect when an agent-mode implementer exits without modifying any files and treat it as a task failure with a descriptive error

**Conversational Planning Hardening**

- **FR-011**: The system MUST handle malformed question markers in the planner's output stream without crashing (skip and continue)
- **FR-012**: The system MUST inform the user when comment-on-approval is unavailable because the planner backend lacks session continuity
- **FR-013**: Clarification answers MUST be persisted to the spec file so they survive workflow interruptions
- **FR-014**: The TUI MUST handle user interruption (Ctrl+C) during any interactive prompt without corrupting state files or leaving orphan planner processes
- **FR-015**: Question markers split across multiple stream chunks MUST be reassembled and parsed correctly

**Planner Version Detection**

- **FR-016**: System MUST detect the planner CLI version before beginning the workflow
- **FR-017**: System MUST select planner CLI flags based on the detected version
- **FR-018**: System MUST display an actionable error message when the planner CLI is not found, showing install guidance
- **FR-019**: System MUST display a warning with fallback behavior when the planner CLI version is unrecognized

### Key Entities

- **Implementer Mode**: Distinguishes between "api" (system writes files from model output), "shell" (subprocess returns code text, system writes files), and "agent" (subprocess writes files directly, system only validates and commits)
- **Planner Version Info**: The detected version identifier and the corresponding set of supported flags and output parsing rules for a planner tool

## Success Criteria

### Measurable Outcomes

- **SC-001**: Users can complete a full workflow (spec through commit) using an agent-style implementer tool, with the same validation/retry/escalation guarantees as API mode
- **SC-002**: The conversational planning flow (questions, answers, spec generation, approval, commenting, regeneration) completes without crashes or data loss in 95% of typical sessions
- **SC-003**: Planner CLI flag-mismatch errors are eliminated for all supported planner versions — users no longer see cryptic flag errors
- **SC-004**: All existing unit tests continue to pass with no regressions
- **SC-005**: Users receive a clear, actionable error message within 5 seconds when a planner CLI is missing or incompatible
- **SC-006**: Agent-mode implementer timeout and crash recovery work reliably — no orphan processes or hung workflows

## Assumptions

- Agent-mode implementers are standalone coding tools that accept a task description (via stdin, argument, or prompt file) and write files to the working directory
- In agent mode, tiny-spec cannot inspect the implementer's intermediate reasoning — it only observes the resulting file changes after the process exits
- The default implementer mode remains "api" (OpenAI-compatible chat) — agent mode is opt-in via configuration
- Claude Code is the primary planner needing version detection; other planner tools are lower priority and can be added incrementally
- Session continuity for comment-on-approval is only available with planner backends that support it (currently claude-code and agent-sdk); for others, "comment" gracefully degrades
- The existing conversational planning code is functionally designed correctly but may have edge-case bugs that surface during real-world use — the goal is to find and fix these, not redesign the architecture
- Constitution Principle VI will be amended (v1.1.0 → v1.2.0) to add a carve-out: file write delegation to the implementer is permitted when tiny-spec retains ownership of validation, retry, escalation, git, and the overall workflow. The anti-goal remains for generic agent-wrapping-agent patterns.
