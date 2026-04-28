# Feature Specification: Cost-Aware Implementer Pool + Plan Review v2

**Created:** 2026-04-28
**Status:** Implemented / Verified with targeted validation
**Input:** User direction: keep diptych focused on expensive planner -> cheap implementer orchestration, support implementer pools/fresh contexts, handle manual user edits, and document implementation-ready briefs.

## Implementation Status

The implemented scope covers the required v2 behavior: implementer profile schema/resolution/routing, cheapest-capable per-task routing with context-fit and write-capability checks, sequential fresh-context task dispatch, user-edit conflict classification/actions, stale `currentCode` cleanup, stopped-loop status handling, task-aware cost accounting, durable session artifacts, Plan Review/TUI routing/context/cost/stale/conflict/runtime metadata, and read-only MCP boundaries.

Same-checkout parallel writes, separate plan archives or plan-management systems, kanban, cross-plan orchestration, generic agent swarms, and write-capable MCP tools remain out of scope. Future expansion in those areas would require a separate spec.

Session history is intentionally in scope. Users should be able to resume runs, browse/filter/search previous sessions, and inspect session artifacts such as `spec.md`, `plan.md`, `tasks.md`, `summary.json`, `review.md`, evidence, and drift. These are workflow records, not a saved-plan archive.

## User Scenarios & Testing

### User Story 1 - Review and correct the plan before cheap tokens are spent (Priority: P1)

A user starts a feature. The expensive planner compiles Task Briefs. Before any implementer runs, the user sees a dense review screen with tasks, files, validation, risk, estimated context size, and selected worker. The user can edit, split, merge, delete, reorder, or send structured feedback to the planner.

**Why this priority:** If the plan is wrong, cheap execution only makes wrong changes cheaper. Plan correction before execution is the highest leverage point.

**Independent Test:** Run a standard-mode workflow with `workflow.briefReview: rich`, produce multiple Task Briefs, edit one task, save, and verify the implementation loop receives the edited tasks from disk.

**Acceptance Scenarios:**

1. **Given** generated Task Briefs, **When** the user opens Plan Review v2, **Then** each task shows files, validation, risk/context posture, and worker selection.
2. **Given** a task that is too large for the selected implementer, **When** the user reviews the plan, **Then** the task is marked as not fitting and cannot be silently dispatched.
3. **Given** a user edits a task and saves, **When** implementation begins, **Then** the saved `tasks.md` is re-parsed and used as source of truth.

### User Story 2 - Execute many tasks without one long implementer context (Priority: P1)

A user has a local 32k model. Diptych should not stuff a 20-task plan into one chat. It should dispatch each task as a fresh worker call with only relevant context.

**Why this priority:** This directly supports the product's cost-saving model.

**Independent Test:** A workflow with three tasks records three independent implementer dispatches, each with its own formatted prompt and routing decision.

**Acceptance Scenarios:**

1. **Given** a plan with multiple tasks, **When** implementation starts, **Then** each task is sent in a fresh implementer call.
2. **Given** a task prompt estimate exceeds the worker context limit, **When** routing runs, **Then** diptych selects a larger worker or blocks with a planner-split/escalation path.
3. **Given** a retry, **When** retry prompt is built, **Then** it includes the task, relevant failure context, and no unrelated session transcript.

### User Story 3 - Use the cheapest capable implementer (Priority: P1)

A user configures multiple implementer profiles. Diptych picks the cheapest profile that can execute the task safely based on context length, runner kind, and capabilities.

**Why this priority:** Cost-aware routing is the product's main differentiator.

**Independent Test:** Given profiles with different context lengths and costs, the router chooses the cheapest profile that fits the task estimate and records the decision.

**Acceptance Scenarios:**

1. **Given** a small task and local worker, **When** routing runs, **Then** local worker is selected.
2. **Given** a task too large for local worker but fitting a cheap cloud worker, **When** routing runs, **Then** cheap cloud worker is selected.
3. **Given** no implementer can fit a task, **When** routing runs, **Then** implementation pauses with a clear planner-split or escalation action.

### User Story 4 - Protect manual user edits (Priority: P1)

A user edits files while diptych is running. Diptych detects whether those edits conflict with current or pending tasks and pauses with actionable options instead of overwriting.

**Why this priority:** Trust breaks immediately if the tool overwrites user work.

**Independent Test:** During a task, modify the same file outside diptych and verify promotion/apply blocks with a conflict event and TUI prompt.

**Acceptance Scenarios:**

1. **Given** the user edits an unrelated file, **When** the next task starts, **Then** diptych reports external changes but can continue safely.
2. **Given** the user edits the current task file, **When** implementer output is ready to apply, **Then** diptych blocks and offers rebase/regenerate, skip, pause, or abort.
3. **Given** the user edits a future task file, **When** Plan Review or scheduler sees it, **Then** affected future tasks are marked stale and can be regenerated before execution.

### User Story 5 - Keep tool calls in the underlying tools (Priority: P2)

A user runs Claude Code, Codex, OpenCode, Kilo, or Agent SDK as planner/implementer. Those tools may use their own tool calls. Diptych provides briefs and guardrails, not a second tool-calling agent layer.

**Why this priority:** This keeps ownership and permissions clear.

**Independent Test:** Docs and config explain that diptych MCP remains read-only and runner tools are external to diptych's deterministic orchestration.

**Acceptance Scenarios:**

1. **Given** a CLI implementer with tool capabilities, **When** diptych dispatches a task, **Then** diptych does not intercept or simulate that tool's internal tool calls.
2. **Given** an MCP-aware external tool, **When** it connects to diptych MCP, **Then** it can read session resources but cannot mutate plans or files.

## Edge Cases

- The configured implementer list is empty or invalid.
- Existing single `implementer` config exists without a pool.
- Two implementer profiles have equal cost and both fit.
- A profile has unknown pricing or unknown context length.
- A task estimate fits the context window but leaves too little safety margin.
- The planner emits a multi-file task despite the quality gate.
- A user edits a dirty-at-start file that the implementer also touches.
- A direct file-writing agent writes outside the task file.
- A CLI implementer uses internal tools and writes files directly.
- Validation fails after a routed worker succeeds syntactically.
- Budget pause triggers between tasks after routing has selected a worker.

## Requirements

### Functional Requirements

- **FR-001:** The system MUST preserve backwards compatibility for existing `implementer` config.
- **FR-002:** The system MUST support optional implementer profiles with model, runner kind, context length, cost posture, and capability metadata.
- **FR-003:** The system MUST estimate formatted task prompt size before dispatch.
- **FR-004:** The system MUST select the cheapest capable implementer profile for a task when profiles exist.
- **FR-005:** The system MUST record per-task routing decisions in state, events, evidence, or summary artifacts.
- **FR-006:** The system MUST execute each task with a fresh implementer context.
- **FR-007:** The system MUST block or re-route tasks that do not fit the selected implementer's context budget.
- **FR-008:** The system MUST keep same-directory task execution sequential in this implementation.
- **FR-009:** The system MUST detect user edits by file and map them to current, future, or unrelated tasks.
- **FR-010:** The system MUST prevent implementer output from overwriting user edits made after the relevant checkpoint.
- **FR-011:** The TUI MUST show current task, selected worker, context fit, checkpoint state, and conflict status.
- **FR-012:** Plan Review v2 MUST let users edit the task plan before implementation and save through the existing parse + quality gate path.
- **FR-013:** Tool-call and MCP docs MUST state that runner tools execute inside the runner, while diptych owns deterministic guardrails.
- **FR-014:** The system MUST preserve durable workflow sessions for resume, session history, previous-session browse/filter/search, and artifact inspection.
- **FR-015:** Tests MUST target behavior and artifacts, not private helper wiring.

### Key Entities

- **ImplementerProfile:** A named concrete worker configuration derived from existing runner config shape.
- **TaskPromptEstimate:** Estimated token size and safety margin for a formatted task prompt.
- **RoutingDecision:** Selected profile, alternatives considered, reason, context fit, and cost posture.
- **ExecutionCheckpoint:** File snapshot or hash boundary used to protect user edits.
- **UserEditConflict:** External change classification with affected files and affected tasks.
- **PlanReviewState:** TUI state for editable tasks plus routing/context metadata.
- **WorkflowSession:** Durable execution record containing run state, artifacts, evidence, drift, checkpoints, and review output.

## Success Criteria

- **SC-001:** Existing single-implementer workflows behave unchanged.
- **SC-002:** A multi-profile config can route small tasks to local workers and larger tasks to larger workers.
- **SC-003:** A task too large for every cheap worker is blocked before implementation with a clear escalation/split path.
- **SC-004:** Manual edits to task files are not overwritten.
- **SC-005:** Plan Review v2 makes context-fit and worker choice visible before execution.
- **SC-006:** The final docs clearly distinguish core session history from out-of-scope plan archives, kanban, and generic multi-agent management.

## Assumptions

- Token estimation remains approximate; use safety margins rather than pretending exact tokenization.
- Existing cost telemetry and pricing helpers are extended, not replaced.
- Existing Task Brief quality gate remains the first defense against oversized or vague tasks.
- Same-directory parallelism stays out of scope for this implementation.
- Any future parallel execution uses isolated worktrees or sandboxes, not writes in one checkout, and is not near-term scope.
- The implementation briefs were dispatched in separate AI contexts.
