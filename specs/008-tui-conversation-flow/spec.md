# Feature Specification: TUI Conversation Flow Redesign

**Feature Branch**: `008-tui-conversation-flow`
**Created**: 2026-03-27
**Status**: Draft
**Input**: User description: "Full TUI redesign: Replace dual-pane raw text layout with single-column conversation flow. Structured TuiEvent union type replaces string[] callbacks. Planner phases shown as conversational text, implementer/validate/git shown as structured tool-call cards. Collapsible diff view (summary by default, expand on demand). Completed tasks collapse to 1 line (expandable). Sticky header with pipeline progress bar. Sticky footer with real-time cost savings display. Stay on Ink 5.x. Full replace of OrchestratorCallbacks to emit structured events. Constitution v1.3.0 already updated."

## User Scenarios & Testing

### User Story 1 - Structured Event Display (Priority: P1)

A developer starts a workflow with `diptych start "add user auth"`. Instead of seeing two panes of raw scrolling text, they see a single-column conversation flow where each significant action appears as a distinct, labeled card. Planner actions (researching, spec writing, planning) appear as conversational text blocks with the planner's name. Implementer actions (code generation, retry) appear as structured tool-call cards showing the operation, target file, and result. Validation results appear as compact pass/fail cards. Git commits appear as one-line confirmations. The developer can immediately see who is doing what, what succeeded, and what failed — the planner/implementer collaboration is visible.

**Why this priority**: This is the core of the redesign. Without structured event rendering, the rest of the features (collapsing, diff, pipeline bar) have nothing to render. The current raw text display is the primary UX problem.

**Independent Test**: Can be tested by running a workflow and verifying that orchestrator events appear as distinct visual cards with role labels, status indicators, and structured content instead of raw text lines.

**Acceptance Scenarios**:

1. **Given** a workflow in the research phase, **When** the planner emits output, **Then** the TUI displays it as a labeled conversational block with the planner's identity and a running/done status indicator.
2. **Given** a workflow in the implementation phase, **When** the implementer generates code for a task, **Then** the TUI displays a tool-call card showing the operation name, model name, target file, lines added/modified, and duration.
3. **Given** a task that fails validation, **When** validation results are available, **Then** the TUI displays a compact card showing each validation stage (typecheck, lint, test) with pass/fail status and the specific error for the failing stage.
4. **Given** a task that triggers escalation, **When** the planner provides a hint, **Then** the TUI displays a visually distinct escalation card showing the tier (hint vs full) and the hint content.
5. **Given** a task that passes validation, **When** the system commits the change, **Then** the TUI displays a one-line commit confirmation with the commit message.
6. **Given** a retry attempt, **When** the implementer retries a failed task, **Then** the TUI displays a retry card showing the attempt number, max retries, and that error context was included.

---

### User Story 2 - Event Model and Callback Replacement (Priority: P1)

The orchestrator's callback system is replaced from raw text emission to structured event emission. Instead of `onPlannerOutput(text: string)` and `onImplementerOutput(text: string)`, the orchestrator emits typed `TuiEvent` objects that carry semantic information (who, what, status, duration, result). The TUI component receives an array of these events and renders each one according to its type. All existing orchestrator behavior (planning, implementation, validation, retry, escalation, commit) continues to work, but now emits structured events instead of raw text.

**Why this priority**: This is the architectural foundation. The TUI cannot render structured cards without structured data. Every other story depends on this event model existing.

**Independent Test**: Can be tested by running a full workflow and verifying that every orchestrator action produces a corresponding typed event, and that the TUI renders each event type as a distinct visual element. Existing tests must continue to pass.

**Acceptance Scenarios**:

1. **Given** the orchestrator starts a workflow, **When** each phase begins and ends, **Then** a structured event is emitted with the phase identity, status (running/done), and optional summary.
2. **Given** the orchestrator sends a task to the implementer, **When** the implementer returns a result, **Then** structured events are emitted for: task start, implementer generation (with file and line count), and generation result (success/failure).
3. **Given** the orchestrator runs validation, **When** validation completes, **Then** a structured event is emitted with individual pass/fail for each stage (typecheck, lint, test) and the error message for any failing stage.
4. **Given** the orchestrator escalates to the planner, **When** escalation produces a hint or full implementation, **Then** a structured event is emitted with the escalation tier and hint content.
5. **Given** the orchestrator commits a task, **When** the commit succeeds, **Then** a structured event is emitted with the commit message.
6. **Given** a complete workflow, **When** all events are collected, **Then** the event sequence is sufficient to reconstruct the full workflow timeline without any raw text.
7. **Given** existing unit and integration tests, **When** the callback system is replaced, **Then** all existing tests pass without regressions (tests may be updated to use the new event interface).

---

### User Story 3 - Collapsible Completed Tasks (Priority: P2)

As the workflow progresses and tasks complete, the developer's screen stays clean and focused. Each completed task automatically collapses to a single summary line showing the task number, title, completion method (local or escalated), retry count if any, and duration. The currently active task remains fully expanded showing all its event cards. The developer can see at a glance how many tasks are done and which one is active without scrolling through completed task details.

**Why this priority**: Without collapsing, a 10+ task workflow produces an unmanageably long scroll. This is essential for usability on real workflows but depends on Story 1 (structured events) being in place.

**Independent Test**: Can be tested by running a workflow with 5+ tasks and verifying that completed tasks collapse to summary lines while the active task shows full detail.

**Acceptance Scenarios**:

1. **Given** a task that completes successfully on the first attempt, **When** the next task begins, **Then** the completed task collapses to a single line: `✓ T{n} {title} — local, {duration}s`.
2. **Given** a task that required retries before succeeding, **When** it completes, **Then** the collapsed line includes the retry count: `✓ T{n} {title} — local, {retries} retries, {duration}s`.
3. **Given** a task that was escalated to the planner, **When** it completes, **Then** the collapsed line indicates escalation: `✓ T{n} {title} — escalated, {duration}s`.
4. **Given** a task that failed permanently, **When** the workflow moves on, **Then** the collapsed line shows failure: `✗ T{n} {title} — failed`.
5. **Given** the currently active task, **When** events are being generated for it, **Then** it remains fully expanded with all its event cards visible.

---

### User Story 4 - Collapsible Diff View (Priority: P2)

When the implementer generates code, the developer sees a compact summary by default showing the target file and number of lines added/modified. The developer can expand this to see the full diff with added lines (green) and removed lines (red) color-coded. When a task retries or escalation produces a fix, the diff for that attempt is shown expanded by default (since the developer likely wants to see what changed). Diffs for completed tasks follow the task's collapsed/expanded state.

**Why this priority**: Code is the core output of the tool. Showing it as raw text wastes the developer's most valuable signal. But showing full diffs for every operation creates visual noise — the collapsible approach balances both.

**Independent Test**: Can be tested by running a workflow and verifying that implementer output shows a compact summary with an expand mechanism revealing a color-coded diff.

**Acceptance Scenarios**:

1. **Given** an implementer that generates code for a task, **When** the generation completes, **Then** the TUI shows a compact summary: `→ {file} (+{n} lines)` with a visual indicator that more detail is available.
2. **Given** a compact diff summary, **When** the developer uses the expand mechanism, **Then** the TUI reveals the full diff with added lines visually distinguished from removed lines.
3. **Given** a retry attempt, **When** the implementer regenerates code, **Then** the diff for the retry is shown expanded by default.
4. **Given** an escalation that produces a fix, **When** the hint or full implementation resolves the issue, **Then** the patch diff is shown expanded by default.
5. **Given** a completed task that has collapsed, **When** it is in collapsed state, **Then** the diff detail is hidden along with the rest of the task's events.

---

### User Story 5 - Pipeline Progress Bar (Priority: P2)

The developer always knows where they are in the workflow. A sticky header at the top of the terminal shows the feature name, a visual pipeline showing all phases (research, spec, plan, implement, review) with the current phase highlighted, and an elapsed timer. The pipeline updates in real-time as the workflow progresses through phases. This header never scrolls away — it remains visible regardless of how much output is below.

**Why this priority**: The current `Phase: implementing` text string doesn't show the full pipeline context. Users can't see how far along they are or what comes next. A sticky pipeline bar provides constant orientation.

**Independent Test**: Can be tested by running a workflow through multiple phases and verifying that the header updates to reflect the current phase, remains visible at the top, and shows correct elapsed time.

**Acceptance Scenarios**:

1. **Given** a workflow is running, **When** the terminal display renders, **Then** the top line shows the feature name, pipeline visualization, and elapsed timer.
2. **Given** the workflow transitions between phases, **When** a new phase begins, **Then** the pipeline visualization updates to show the new current phase with completed phases marked and upcoming phases shown as pending.
3. **Given** the conversation flow has more content than fits on screen, **When** the developer scrolls through events, **Then** the header remains fixed at the top and does not scroll with the content.
4. **Given** the terminal is resized, **When** the width or height changes, **Then** the header adapts to the new dimensions without breaking the layout.

---

### User Story 6 - Cost Savings Footer (Priority: P2)

The developer always sees the cost impact of using diptych. A sticky footer at the bottom of the terminal shows: current task progress (e.g., "4/8"), percentage of tasks completed locally (the core value proposition), estimated cost so far, estimated savings compared to using the planner for everything, and the implementer model name. This footer updates in real-time as tasks complete and cost data accumulates.

**Why this priority**: Cost savings is the entire USP of diptych, but the current UI makes it invisible. Showing savings in real-time reinforces the product's value and helps developers understand the cost/quality tradeoff.

**Independent Test**: Can be tested by running a workflow and verifying the footer displays accurate, updating cost metrics that remain visible at all times.

**Acceptance Scenarios**:

1. **Given** a workflow is running, **When** the terminal display renders, **Then** the bottom line shows task progress, local completion rate, estimated cost, estimated savings, and model name.
2. **Given** a task completes via the local implementer, **When** the footer updates, **Then** the local completion rate increases and the savings amount increases.
3. **Given** a task is escalated to the planner, **When** the footer updates, **Then** the local completion rate decreases proportionally and the actual cost increases.
4. **Given** the conversation flow has more content than fits on screen, **When** the developer scrolls, **Then** the footer remains fixed at the bottom.
5. **Given** the workflow completes, **When** the summary screen appears, **Then** the final footer values match the summary's cost breakdown.

---

### User Story 7 - Approval and Question Prompts Inline (Priority: P3)

During the spec and plan phases, when the planner generates a spec or plan that needs user approval, the approval prompt appears inline in the conversation flow — not as a separate overlay. The developer sees the planner's output, followed immediately by the approval options (approve, edit, comment, quit). Similarly, when the planner asks clarification questions, they appear inline as interactive cards within the flow. This maintains the natural conversation metaphor — the planner asks, the user answers, the flow continues.

**Why this priority**: The existing approval and question prompts work functionally. Making them inline improves the conversational feel but is not a prerequisite for other features.

**Independent Test**: Can be tested by triggering a spec approval and a clarification question during a workflow and verifying they appear inline within the conversation flow.

**Acceptance Scenarios**:

1. **Given** the planner completes a spec, **When** approval is needed, **Then** the approval prompt appears as the next card in the conversation flow with clearly labeled options.
2. **Given** the planner asks clarification questions, **When** questions are detected, **Then** they appear as interactive cards in the flow with selectable options and a text input for custom answers.
3. **Given** the developer approves a spec, **When** the workflow continues, **Then** the approval card updates to show the approved state and the next phase begins below it.
4. **Given** the developer comments on a spec, **When** the comment is submitted, **Then** the comment text appears as a user card in the flow and the planner's regenerated output appears below.

---

### Edge Cases

- Terminal width less than 60 columns — cards must degrade gracefully (truncate or wrap)
- Terminal height less than 10 rows — header and footer must still render, middle section gets minimal space
- Workflow with 0 tasks (planner generates empty task list) — should show appropriate message
- Implementer produces empty output (no files modified) — event card should indicate "no changes"
- Very long file paths in diff summaries — must truncate with ellipsis
- Very large diffs (1000+ lines) — must truncate with "showing first N lines" indicator
- Rapid event emission (many events per second) — rendering must not flicker or drop frames
- Terminal resize during active workflow — layout must reflow without losing events
- SIGINT (Ctrl+C) during any phase — cleanup must work regardless of which card is being rendered
- Auto mode (--auto) — all prompts auto-approve, but events still render for visibility

## Requirements

### Functional Requirements

**Event Model**

- **FR-001**: System MUST define a `TuiEvent` union type that represents all orchestrator actions as structured data (planner status, planner text, task lifecycle, implementer generation, validation, retry, escalation, git commit, error)
- **FR-002**: Each `TuiEvent` MUST carry sufficient information for the TUI to render it without accessing external state (self-contained rendering data)
- **FR-003**: System MUST replace `onPlannerOutput(text: string)` and `onImplementerOutput(text: string)` callbacks with a single `onEvent(event: TuiEvent)` callback
- **FR-004**: System MUST preserve existing callback functionality for `onApprovalNeeded`, `onQuestionAsked`, `onExternalChanges`, and `onComplete` — these are interactive and cannot be replaced by passive events
- **FR-005**: System MUST emit events for all orchestrator actions: phase changes, task lifecycle, implementer generation (including file and line count), validation results (per-stage), retry attempts, escalation (with tier and hint), git commits, and errors

**Conversation Flow Layout**

- **FR-006**: System MUST render events as a single-column scrollable conversation flow instead of a dual-pane layout
- **FR-007**: System MUST render a sticky header (fixed at terminal top) showing feature name, pipeline phase visualization, and elapsed timer
- **FR-008**: System MUST render a sticky footer (fixed at terminal bottom) showing task progress, local completion rate, estimated cost, estimated savings, and implementer model name
- **FR-009**: The scrollable middle section MUST auto-follow the latest event (like `tail -f`) unless the developer has manually scrolled up
- **FR-010**: System MUST adapt the layout when the terminal is resized without losing event data

**Event Card Rendering**

- **FR-011**: Planner events (research, spec, plan) MUST render as conversational text blocks with a role label and status indicator
- **FR-012**: Implementer events (code generation) MUST render as structured tool-call cards showing operation, model, file, result summary, and duration
- **FR-013**: Validation events MUST render as compact cards showing per-stage pass/fail with error details for failing stages
- **FR-014**: Escalation events MUST render as visually distinct cards showing the tier and hint/implementation content
- **FR-015**: Retry events MUST show the attempt number and max retries
- **FR-016**: Git commit events MUST render as one-line confirmations with the commit message
- **FR-017**: Error events MUST render as visually distinct cards with the error message

**Collapsible Behavior**

- **FR-018**: Completed tasks MUST automatically collapse to a single summary line when the next task begins
- **FR-019**: The collapsed summary line MUST show: task number, title, completion method (local/escalated/failed), retry count (if any), and duration
- **FR-020**: The currently active task MUST remain fully expanded with all its event cards visible
- **FR-021**: Implementer generation cards MUST show a compact summary by default (file name, lines added/modified)
- **FR-022**: The compact summary MUST be expandable to reveal the full diff with color-coded additions and removals
- **FR-023**: Diffs for retry attempts and escalation fixes MUST be shown expanded by default

**Pipeline and Cost Tracking**

- **FR-024**: The pipeline visualization MUST show all workflow phases with distinct indicators for completed, current, and pending phases
- **FR-025**: The cost footer MUST update in real-time as tasks complete, reflecting current local completion rate and estimated savings
- **FR-026**: Cost calculations MUST use the existing `CostBreakdown` and `pricing.ts` infrastructure

**Compatibility**

- **FR-027**: All existing unit tests MUST pass after the callback system replacement (tests may be updated to use the new event interface)
- **FR-028**: The `--auto` mode MUST work with the new TUI — events render but prompts auto-approve
- **FR-029**: The `resume` command MUST work with the new TUI — resumed workflows emit events for their remaining tasks
- **FR-030**: The summary screen MUST continue to work, displaying final cost breakdown and task statistics

### Key Entities

- **TuiEvent**: A discriminated union representing every renderable orchestrator action. Each variant carries type-specific data needed for self-contained rendering (e.g., implementer-generate carries file path, line count, diff text, duration).
- **EventCard**: A TUI component that takes a single TuiEvent and renders it as a visually appropriate card based on its type.
- **ConversationFlow**: A TUI component that manages the scrollable list of EventCards with auto-follow behavior and manual scroll support.
- **PipelineBar**: A TUI component rendering the phase progress visualization in the sticky header.
- **CostFooter**: A TUI component rendering real-time cost metrics in the sticky footer.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A developer running a 10-task workflow can identify which role (planner or implementer) performed each action at a glance, without reading raw text output
- **SC-002**: Completed tasks occupy no more than 1 line each in the default view, keeping the visible area focused on the active task
- **SC-003**: The developer can see current pipeline phase, task progress, and cost savings at all times regardless of scroll position
- **SC-004**: All 227+ existing unit tests pass without regressions after the callback system replacement
- **SC-005**: The full workflow (start through summary) completes successfully with the new TUI for both interactive and auto modes
- **SC-006**: The TUI renders without visible flicker or frame drops during normal workflow operation (events emitted at typical orchestrator speed)
- **SC-007**: Cost savings displayed in the footer match the final summary's cost breakdown within rounding tolerance
- **SC-008**: The TUI layout adapts correctly when the terminal is resized to at least 60x10 characters minimum

## Assumptions

- The existing `OrchestratorCallbacks` interface is the only integration point between the orchestrator and TUI — no other code path emits display data
- The `Summary` and `CostBreakdown` types already have all data needed for the cost footer — no new pricing logic is required
- Ink 5.x can achieve sticky header/footer behavior through manual height management using `useStdout().rows` (already demonstrated in the current `layout.tsx`)
- Color-coded diff rendering (green for additions, red for removals) is achievable with Ink's `<Text color="green">` without additional dependencies
- The existing `extractor.ts` already parses code from model output — diff computation (comparing before/after) may need a lightweight string diff utility
- Terminal minimum size of 60 columns x 10 rows is a reasonable lower bound — below this, degraded rendering is acceptable
- The `spec` command (spec-only mode without implementation) should also benefit from the conversation flow for planner phases
- Phase timeline in the pipeline bar uses the existing `Phase` type — no new phases are introduced
