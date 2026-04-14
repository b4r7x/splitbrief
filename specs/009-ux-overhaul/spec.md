# Feature Specification: UX Overhaul — Home Screen, Permission Modes, Cascading Regeneration, and Dialog-Style TUI

**Feature Branch**: `009-ux-overhaul`
**Created**: 2026-03-28
**Status**: Draft
**Input**: User description: "Complete UX overhaul: interactive home screen, 4 permission modes with Tab switching, cascading spec/plan regeneration with back navigation, TLDR changeset cards, dialog-style box-drawing TUI, task-level control in supervised mode, and comprehensive keyboard shortcuts."

## User Scenarios & Testing

### User Story 1 - Home Screen and Interactive Mode (Priority: P1)

When a user runs `diptych` with no arguments, the CLI launches an interactive home screen instead of printing help text. The screen displays centered branding using box-drawing characters ("t i n y - s p e c" with tagline "plan smart, build cheap"), contextual information about the current environment (active planner, implementer model, project directory, git branch and clean/dirty status), a centered text input field prompting "What do you want to build?", and a row of available slash commands at the bottom (/models, /config, /status, /resume, /help). Typing "/" in the input field activates a slash command mode that filters the command list as the user types. Pressing Enter with non-slash text starts the full workflow identically to `diptych start "text"`. The existing `diptych start "feature"` CLI entry point continues to work unchanged for scripting and muscle-memory compatibility.

**Why this priority**: The current CLI requires users to already know the command syntax. A home screen with context and input makes the tool immediately approachable, reduces onboarding friction to zero keystrokes, and establishes visual identity. Every subsequent feature (permission modes, slash commands, model switching) depends on this interactive shell existing.

**Independent Test**: Run `diptych` with no arguments in a configured project directory and verify the home screen renders with branding, context info, input field, and slash command hints. Type a feature description and confirm the workflow starts.

**Acceptance Scenarios**:

1. **Given** the user has a configured project (`.diptych/config.yaml` exists, git initialized), **When** they run `diptych` with no arguments, **Then** the home screen renders showing the branding header, the configured planner name, the implementer model name, the current working directory, the current git branch with clean/dirty indicator, the text input field with placeholder "What do you want to build?", and the slash command hints at the bottom.

2. **Given** the home screen is displayed, **When** the user types "add user authentication" and presses Enter, **Then** the workflow starts with that feature description identically to running `diptych start "add user authentication"`, transitioning from the home screen to the conversation flow layout.

3. **Given** the home screen is displayed, **When** the user types "/" in the input field, **Then** the input switches to slash command mode, displaying a filtered list of available commands (/models, /config, /status, /resume, /help) that narrows as the user continues typing (e.g., "/m" shows only /models and /mode).

4. **Given** the slash command list is visible, **When** the user selects /status and presses Enter, **Then** the status output renders inline (same content as `diptych status`) and the user returns to the home screen input afterward.

5. **Given** no `.diptych/config.yaml` exists in the project, **When** the user runs `diptych` with no arguments, **Then** the home screen still renders but the context section shows "No config found — run /init" in place of planner/implementer details, and entering a feature description triggers the init picker automatically before starting the workflow.

6. **Given** a `.diptych/state.json` exists with an interrupted workflow, **When** the home screen renders, **Then** a notice appears above the input field: "Resumable workflow: [feature name] — /resume to continue", and the /resume slash command is visually highlighted.

7. **Given** the user runs `diptych start "add caching"` directly from their shell, **When** the command executes, **Then** the workflow starts immediately with the conversation flow layout (no home screen), preserving full backwards compatibility.

8. **Given** the home screen is displayed and the user has typed partial text, **When** the user presses Escape, **Then** the input field clears and returns to the placeholder state without exiting the application.

---

### User Story 2 - Permission Modes with Runtime Switching (Priority: P1)

Four permission modes control the level of user approval required during workflow execution: **supervised** (approve spec, plan, and each task before implementation and after validation), **normal** (approve spec and plan only; tasks run automatically — this is the default), **auto** (everything runs without any user interaction), and **plan-only** (generates spec, plan, and tasks, then stops before implementation). The active mode is displayed in the footer as a bracketed indicator: [S], [N], [A], or [P]. Pressing Tab at any point during the workflow opens a mode picker overlay (a list navigable with up/down arrows, confirmed with Enter, dismissed with Escape). Mode changes take effect starting from the next action — if the user switches from supervised to auto mid-workflow, any pending approval prompt resolves automatically as "approve". The mode can also be set via CLI flag (`--mode supervised`), config file (`mode: supervised` in `.diptych/config.yaml`), or the `/mode` slash command from the home screen. Precedence is: CLI flag > runtime switch > config file > default (normal).

**Why this priority**: Permission modes directly determine how the user interacts with every phase of the workflow. The supervised mode is essential for cautious first-time users, auto mode enables CI/scripting use cases, and plan-only mode supports teams that want AI planning without AI implementation. Runtime switching means users don't have to restart a workflow to adjust their comfort level. This must ship alongside the home screen because the mode indicator is part of the core footer.

**Independent Test**: Start a workflow in normal mode, verify spec and plan require approval but tasks auto-run. Press Tab mid-workflow, switch to supervised, and verify the next task pauses for approval. Switch to auto and verify remaining tasks complete without prompts.

**Acceptance Scenarios**:

1. **Given** no mode is specified via CLI flag or config, **When** the user starts a workflow, **Then** the mode defaults to "normal", the footer displays [N], spec and plan phases pause for user approval, and tasks run automatically without per-task approval prompts.

2. **Given** the workflow is running in any mode, **When** the user presses Tab, **Then** a mode picker overlay appears listing all four modes with the current mode highlighted, navigable with up/down arrows, confirmable with Enter, and dismissable with Escape without changing the mode.

3. **Given** the workflow is in supervised mode and paused at a task approval prompt, **When** the user presses Tab and switches to auto mode, **Then** the pending task approval resolves as "approve", the mode indicator changes to [A], and all subsequent tasks and phases proceed without further approval prompts.

4. **Given** the workflow is in auto mode, **When** the user presses Tab and switches to supervised mode, **Then** the mode indicator changes to [S], and the next task pauses for approval before implementation begins (the currently running task, if any, completes normally).

5. **Given** the user runs `diptych start "feature" --mode supervised`, **When** the workflow starts, **Then** the mode is set to supervised regardless of the config file value, the footer shows [S], and every phase (spec, plan, each task) requires explicit approval.

6. **Given** the mode is set to plan-only (via CLI, config, or runtime switch), **When** the planner finishes generating spec, plan, and tasks, **Then** the workflow stops with a summary showing the generated artifacts, does not begin implementation, and exits cleanly with a message indicating plan-only mode completed.

7. **Given** the mode is set to auto, **When** the workflow runs end-to-end, **Then** no approval prompts appear at any phase, the spec is auto-approved, the plan is auto-approved, all tasks run sequentially without pauses, and the final summary renders automatically.

8. **Given** the config file contains `mode: supervised` and the user runs `diptych start "feature" --mode auto`, **When** the workflow starts, **Then** auto mode is used (CLI flag takes precedence over config), and the footer shows [A].

9. **Given** the home screen is displayed, **When** the user types `/mode` and selects a mode from the slash command interface, **Then** the mode is set for the next workflow started from the home screen, and the footer indicator updates immediately to reflect the new mode.

---

### User Story 3 - Cascading Regeneration with Back Navigation (Priority: P1)

During spec and plan review, the user can provide feedback (comment or edit) that triggers regeneration, and can navigate backward between review phases. When the user comments on the spec, the planner regenerates the spec incorporating the feedback and returns to spec review (a loop until the user approves). When the user edits the spec via $EDITOR, the system prompts "Spec edited. Regenerate plan? [y/n]" — answering yes cascades: the planner regenerates the plan and tasks from the edited spec, then returns to plan review. When the user comments on the plan, the planner regenerates the plan and tasks, returning to plan review. When the user edits the plan via $EDITOR, the system prompts "Plan edited. Regenerate tasks? [y/n]" — answering yes regenerates tasks only. Pressing [b] during plan review navigates back to spec review; pressing [b] during the review gate (pre-implementation summary) navigates back to plan review. When the spec is approved (after any number of comment/edit/back cycles), the plan and tasks auto-regenerate from the final spec if the spec changed since the plan was last generated. A review gate before implementation displays a full summary: all tasks with titles and sequence, current permission mode, active planner, active implementer, and estimated cost — requiring explicit approval (or auto-resolving in auto mode) before implementation begins.

**Why this priority**: Without feedback loops and back navigation, users are forced to either accept imperfect specs/plans or quit and restart. This is the core interactive planning experience — the primary value proposition of using an expensive planner is that the user can iteratively refine the plan before committing cheap implementation tokens. Cascading regeneration ensures consistency (spec changes propagate to plan and tasks). This must ship with P1 because it defines the approval flow that permission modes (Story 2) control.

**Independent Test**: Start a workflow, comment on the spec twice (verify loop), approve the spec, press [b] to go back to spec review, approve again, comment on the plan (verify regeneration), press [b] to go back to spec from plan, navigate forward again, approve plan, verify review gate shows task summary, approve to start implementation.

**Acceptance Scenarios**:

1. **Given** the spec is displayed for review, **When** the user selects "comment" and types feedback (e.g., "Add rate limiting to the auth endpoints"), **Then** the planner regenerates the spec incorporating the feedback, the updated spec is displayed, and the user is back at spec review with the same options (approve, comment, edit, quit).

2. **Given** the user has commented on the spec, **When** the regenerated spec is displayed and the user approves it, **Then** the planner generates (or regenerates) the plan and tasks based on the approved spec, and the plan is displayed for review.

3. **Given** the spec is displayed for review, **When** the user selects "edit" and $EDITOR opens with the spec content, and the user modifies the spec and saves, **Then** the system displays "Spec edited. Regenerate plan? [y/n]" — if yes, the planner regenerates the plan and tasks from the edited spec and shows plan review; if no, the existing plan is kept and plan review is shown.

4. **Given** the plan is displayed for review, **When** the user selects "comment" and types feedback (e.g., "Split task 3 into two smaller tasks"), **Then** the planner regenerates the plan and tasks incorporating the feedback, the updated plan is displayed, and the user is back at plan review.

5. **Given** the plan is displayed for review, **When** the user selects "edit" and modifies the plan in $EDITOR, **Then** the system displays "Plan edited. Regenerate tasks? [y/n]" — if yes, only tasks are regenerated from the edited plan; if no, existing tasks are kept.

6. **Given** the plan is displayed for review, **When** the user presses [b], **Then** the view navigates back to spec review showing the current spec, with all review options available (approve, comment, edit, quit). The previously generated plan is preserved but marked as potentially stale.

7. **Given** the review gate (pre-implementation summary) is displayed, **When** the user presses [b], **Then** the view navigates back to plan review showing the current plan with all review options available.

8. **Given** the user navigates back from plan review to spec review and then comments on the spec causing regeneration, **When** the user approves the new spec, **Then** the plan and tasks are automatically regenerated from the new spec (since the spec changed after the plan was last generated), and plan review displays the fresh plan.

9. **Given** the review gate is displayed, **When** the user views the summary, **Then** it shows: a numbered list of all tasks with titles, the current permission mode (e.g., "normal"), the active planner (e.g., "claude-code"), the active implementer (e.g., "ollama/qwen2.5-coder:7b"), and estimated cost breakdown. The user can approve to begin implementation, press [b] to go back, or quit.

10. **Given** the workflow is in auto mode and reaches the spec phase, **When** the spec is generated, **Then** the spec is auto-approved without pausing for review, the plan and tasks are generated and auto-approved, the review gate is auto-approved, and implementation begins immediately — no back navigation or comment/edit loops occur.

---

### User Story 4 - TLDR Changeset Cards (Priority: P2)

After any artifact regeneration (spec, plan, or tasks), the planner generates a TLDR summary of what changed, displayed as a changeset card in the conversation flow. On regeneration, the planner appends `<!-- TLDR ... -->` markers to its output. A parser extracts these markers (following the same pattern as the existing question marker parser). A new TuiEvent type carries the parsed changeset data. A ChangesCard component renders inside a box with categorized added/changed/removed items and a summary line (e.g., "4 stories -> 5 | 24 FRs -> 22 | net: -2 FRs"). Changeset cards only appear after regeneration — the first generation of any artifact produces no TLDR. Each regeneration cycle produces its own independent TLDR card. The planner prompt instructs TLDR generation only when prior artifact content exists, costing approximately 200 extra tokens per regeneration.

**Why this priority**: Regeneration is a common workflow (users comment on specs/plans, planner regenerates), and without a changeset summary users must manually diff long markdown documents to understand what changed. This directly reduces friction in the approval loop, but is not blocking for core task execution.

**Independent Test**: Trigger a spec regeneration by commenting on an existing spec during an approval prompt. Verify the changeset card appears in the conversation flow with correct added/changed/removed items. Run a fresh `start` command and confirm no changeset card appears after first-generation artifacts.

**Acceptance Scenarios**:

1. **Given** a spec has been generated and the user comments requesting changes during approval, **When** the planner regenerates the spec with TLDR markers, **Then** a changeset event card appears showing added, changed, and removed items with a summary line comparing before/after counts.

2. **Given** a plan has been generated and the user comments requesting changes during approval, **When** the planner regenerates the plan with TLDR markers, **Then** a changeset event card appears showing the categorized diff and the previous plan approval card remains visible above it.

3. **Given** a fresh workflow is started with no prior artifacts, **When** the planner generates the spec for the first time, **Then** no changeset card appears in the conversation flow.

4. **Given** the user requests multiple rounds of changes to a spec, **When** the planner regenerates the spec twice, **Then** each regeneration produces its own separate TLDR changeset card in chronological order in the conversation flow, and each reflects only the delta from the immediately preceding version.

5. **Given** a regeneration where the planner output does not contain valid TLDR markers, **When** the parser processes the output, **Then** no changeset card is emitted and the regenerated artifact is still displayed normally without error.

---

### User Story 5 - Dialog-Style Event Cards (Priority: P2)

Replace the current flat event log with dialog-style cards using box-drawing characters for visual grouping. Cards use box-drawing borders — no emoji unicode. Labels are ASCII tags: [PLAN], [IMPL], [SPEC], [REVIEW], [CHANGES]. Flow arrows between cards indicate communication direction: down-arrow for task dispatch to implementer, up-arrow for escalation back to planner. Pass/fail indicators use `*` for pass and `x` for fail. Color scheme: planner output in blue/cyan, implementer output in green, validation results rendered within the implementer card (not as separate cards), escalation in yellow, errors in red, git operations in gray. Completed tasks collapse to a single summary line. The active task card stays expanded with live-updating content as the implementer streams output.

**Why this priority**: The visual design of the conversation flow is the product's primary interface and directly shapes user trust and comprehension during long-running workflows. Box-drawing cards with directional flow arrows make the planner/implementer dialog legible at a glance, but the feature builds on top of the existing event system and does not gate any functional capability.

**Independent Test**: Run a full workflow with at least two tasks (one passing, one requiring retry/escalation). Verify each event type renders with correct box-drawing borders, ASCII labels, color coding, and flow arrows. Confirm completed tasks collapse and the active task remains expanded.

**Acceptance Scenarios**:

1. **Given** the planner emits spec content during the planning phase, **When** the TUI renders the event, **Then** a card with box-drawing borders, [PLAN] label, blue/cyan colored content is displayed using box-drawing characters with no emoji unicode.

2. **Given** the implementer completes a task with passing validation, **When** the TUI renders the implementer event, **Then** the card shows [IMPL] label in green, includes the diff inside the card body, shows validation results (`* tsc`, `* lint`, `* test`) within the same card, and a down-arrow flow indicator appears above the card indicating dispatch from planner.

3. **Given** a task fails validation and escalates to the planner, **When** the escalation event is emitted, **Then** an up-arrow flow indicator appears between the implementer card and the subsequent planner escalation card, the escalation card uses yellow coloring and the [PLAN] label, and the failed validation shows `x` indicators.

4. **Given** three tasks have completed and a fourth is in progress, **When** the conversation flow renders, **Then** the first three tasks each display as a single collapsed summary line, and the fourth task card is expanded showing live-updating implementer output.

5. **Given** a git commit occurs after a successful task, **When** the commit event renders, **Then** it appears in gray text within or immediately after the implementer card, showing the commit message.

---

### User Story 6 - Task-Level Control in Supervised Mode (Priority: P2)

In supervised mode, the user has granular control over each task before and after implementation. Before implementation, a task preview card displays the task number, title, action (create/modify), target file path, dependency list, and description. The user can press Enter to implement, `s` to skip the task, or `e` to edit the task description before proceeding. After implementation and before commit, the TUI shows the implementer output card with the diff and validation results. The user can press Enter to commit, `d` to view the full diff, `r` to retry (discard changes and re-implement), `s` to skip (discard changes and move on), or `e` to open the file in $EDITOR then re-validate. When validation fails, the error is displayed and the user is offered `r` to retry or `s` to skip; escalation to the planner happens automatically after the configured max retries. In normal and auto modes, task-level control is skipped entirely — tasks run, validate, and commit without user intervention.

**Why this priority**: Supervised mode is a core differentiator for users who want oversight over AI-generated code without dropping to fully manual workflows. Task-level control gives users confidence to run diptych on production codebases. However, it depends on the dialog-style cards (US5) for the task preview and post-implementation review UI, and the core orchestration loop already functions without it.

**Independent Test**: Run a workflow in supervised mode with at least three tasks. Verify the pre-task preview card appears with correct metadata, test each key binding (Enter, s, e), then after implementation verify the post-implementation review card with each key binding (Enter, d, r, s, e). Run the same workflow in normal mode and confirm no approval prompts appear at task boundaries.

**Acceptance Scenarios**:

1. **Given** supervised mode is active and the orchestrator reaches a new task, **When** the task preview card renders, **Then** it displays task number, title, action type, file path, dependencies, and description, and the footer shows [Enter] implement  [s] skip  [e] edit.

2. **Given** the user presses `s` on a task preview in supervised mode, **When** the skip is processed, **Then** the task is marked as skipped, no implementation runs, a collapsed skip line appears in the conversation flow, and the orchestrator advances to the next task.

3. **Given** implementation completes with passing validation in supervised mode, **When** the post-implementation review card renders, **Then** it shows the implementer output, diff, and validation results, and the footer shows [Enter] commit  [d] diff  [r] retry  [s] skip  [e] edit.

4. **Given** the user presses `r` on the post-implementation review, **When** the retry is processed, **Then** all file changes from the current attempt are discarded, the implementer runs the task again, and the new result replaces the previous attempt in the review card.

5. **Given** the user presses `e` on the post-implementation review, **When** $EDITOR opens and the user saves changes, **Then** validation re-runs on the edited file, the diff updates to reflect manual edits, and the review card refreshes with the new validation results.

6. **Given** normal mode is active, **When** the orchestrator processes tasks, **Then** no pre-task preview or post-implementation review prompts appear, and tasks implement, validate, and commit automatically.

---

### User Story 7 - Keyboard Shortcuts and Help (Priority: P3)

A comprehensive keyboard shortcut system provides context-sensitive key bindings throughout the TUI. Global shortcuts are always available: Tab opens the mode picker, `q` quits, up/down arrows scroll the conversation flow, `d` toggles diff expansion, `/` opens slash command input, and `?` shows a help overlay. During approval prompts, available keys are: Enter (approve), `e` (edit), `c` (comment), `b` (back), `q` (quit). During supervised task review (US6), available keys are: Enter (implement/commit), `s` (skip), `e` (edit), `r` (retry), `d` (full diff). Pressing `?` at any time displays a help overlay listing all shortcuts available in the current context. The overlay dismisses on any subsequent key press. Shortcuts are context-sensitive: only actions valid for the current TUI state are active, and pressing an inactive key has no effect. The sticky footer displays the most relevant shortcuts for the current state as a hint bar.

**Why this priority**: Keyboard shortcuts are a polish feature that improves power-user efficiency but is not required for any functional workflow. The help overlay reduces onboarding friction. This story depends on the task-level control (US6) and dialog cards (US5) being in place so that all shortcut contexts exist.

**Independent Test**: At each stage of a supervised workflow (planning, spec approval, task preview, post-implementation review, summary), press `?` and verify the help overlay shows the correct shortcuts for that context. Press a listed shortcut and verify it triggers the expected action. Verify inactive shortcuts are ignored. Confirm the footer hint bar updates at each state transition.

**Acceptance Scenarios**:

1. **Given** the TUI is in any state, **When** the user presses `?`, **Then** a help overlay appears listing all shortcuts available in the current context with their descriptions, and pressing any key dismisses the overlay.

2. **Given** the TUI is at a spec approval prompt, **When** the help overlay is shown, **Then** it lists Enter (approve), `e` (edit), `c` (comment), `b` (back), `q` (quit) and does not list task-specific shortcuts like `s` (skip) or `r` (retry).

3. **Given** the TUI is displaying the conversation flow with no active prompt, **When** the user presses up or down arrow, **Then** the conversation flow scrolls accordingly, and **When** the user presses `d`, **Then** the most recent diff card toggles between collapsed and expanded states.

4. **Given** the TUI transitions from spec approval to task execution in supervised mode, **When** the state changes, **Then** the sticky footer updates from showing approval shortcuts to showing task-level shortcuts, and the `?` overlay reflects the new context if opened.

5. **Given** the user presses `s` while at a spec approval prompt (where `s` is not a valid action), **When** the key event is processed, **Then** nothing happens — no error, no state change, no visual feedback — and the TUI remains at the approval prompt.

---

### Edge Cases

- **EC-001: Terminal resize during overlay.** If the terminal is resized while the mode picker or help overlay is displayed, the overlay MUST re-render to fit the new terminal dimensions without crashing or leaving visual artifacts.

- **EC-002: Mode switch during active task.** If the user switches from auto to supervised mode via Tab while a task implementation is in progress, the mode change MUST NOT interrupt the running implementation. The new mode MUST take effect at the next decision point (post-implementation approval or next task preview).

- **EC-003: Back navigation after regeneration.** If the user regenerates the plan via comment, then presses [b] from the review gate to return to plan review, the system MUST display the most recently regenerated plan, not the original.

- **EC-004: SIGINT during planner regeneration.** If the user sends SIGINT (Ctrl+C) while the planner is regenerating a spec or plan, the system MUST terminate the planner subprocess, discard partial output, preserve the last approved version of the spec/plan, and return to the review prompt for the artifact that was being regenerated.

- **EC-005: Empty or missing TLDR in regeneration response.** If the planner returns a regenerated spec or plan without a TLDR marker, the system MUST NOT emit a changeset event. The regenerated content MUST still be accepted and displayed normally.

- **EC-006: Rapid mode switching.** If the user opens the mode picker and rapidly toggles through modes, only the mode confirmed with Enter MUST be applied. Arrow key navigation without Enter MUST NOT change the active mode.

- **EC-007: Config file missing during home screen render.** If `.diptych/config.yaml` is deleted or unreadable after the home screen has already rendered, the system MUST handle the error gracefully when the user attempts to start a workflow, displaying an actionable error message rather than crashing.

- **EC-008: Very long feature description.** If the user types a feature description longer than the terminal width in the home screen input, the input MUST visually wrap or scroll horizontally. The full text MUST be preserved and passed to the workflow without truncation.

- **EC-009: Slash command typo.** If the user types an unrecognized slash command (e.g., "/stauts"), the system MUST display "Unknown command" with the list of valid commands. The system MUST NOT start a workflow with the mistyped command as a feature description.

- **EC-010: Conflicting CLI flag and config mode.** If the user specifies `--mode auto` on the CLI but the config file specifies `mode: supervised`, the CLI flag MUST take precedence. No warning is required.

- **EC-011: Back navigation at spec review.** If the user presses [b] during spec review (the earliest review stage), the system MUST ignore the keypress. There is no prior stage to navigate to.

- **EC-012: Skip all tasks in supervised mode.** If the user skips every task via [s] in supervised mode, the system MUST proceed to the final summary. The summary MUST report all tasks as skipped with zero implementation cost.

## Requirements

### Functional Requirements

#### Home Screen

- **FR-001**: Running `diptych` with no arguments MUST display the home screen inside the TUI.
- **FR-002**: The home screen MUST display branding, context block (configured planner, configured implementer model name, project directory basename, current git branch), and a text input prompt.
- **FR-003**: Typing a feature description and pressing Enter on the home screen MUST start the full workflow, identical in behavior to running `diptych start "<text>"`.
- **FR-004**: Typing `/` as the first character in the home screen input MUST activate slash command mode, displaying a filtered list of available commands below the input.
- **FR-005**: The following slash commands MUST be recognized and execute their respective actions: `/models` (list detected planners and implementers), `/config` (open or display configuration), `/status` (show workflow state), `/resume` (resume interrupted workflow), `/help` (display available commands and shortcuts), `/init` (create default configuration).
- **FR-006**: The existing `diptych start "feature"` CLI invocation MUST continue to work and MUST bypass the home screen, entering the workflow directly.
- **FR-007**: When no `.diptych/config.yaml` exists, the home screen MUST display a notice indicating missing configuration and MUST suggest running `/init`.
- **FR-008**: When a resumable workflow exists (`.diptych/state.json` with a non-terminal phase), the home screen MUST display a notice indicating the interrupted workflow and MUST suggest running `/resume`.

#### Permission Modes

- **FR-009**: The system MUST support exactly four permission modes: `supervised` (pause before and after every task), `normal` (pause at spec, plan, and review gate only), `auto` (no pauses), `plan-only` (generate spec/plan/tasks then stop).
- **FR-010**: The default permission mode MUST be `normal`. The mode MAY be overridden by `mode` in `.diptych/config.yaml` or by the `--mode` CLI flag. CLI flag MUST take precedence over config file.
- **FR-011**: Pressing the Tab key at any idle prompt MUST open a mode picker overlay. The overlay MUST support arrow key navigation and Enter to confirm selection. Pressing Escape MUST dismiss the overlay without changing the mode.
- **FR-012**: The footer MUST display the current mode as a bracketed indicator: [S], [N], [A], or [P].
- **FR-013**: Mode changes MUST take effect starting from the next pending action. A mode change MUST NOT retroactively alter the behavior of an action already in progress.
- **FR-014**: In `supervised` mode, the system MUST pause and wait for user approval both before starting each task implementation and after each task implementation completes (including validation results).
- **FR-015**: In `auto` mode, the system MUST proceed through the entire workflow without pausing for user interaction.
- **FR-016**: In `plan-only` mode, the system MUST stop after generating and displaying the spec, plan, and task list. The system MUST NOT begin task implementation.

#### Cascading Regeneration

- **FR-017**: Comment on spec MUST trigger planner regeneration of spec and return to spec review.
- **FR-018**: Comment on plan MUST trigger planner regeneration of plan and return to plan review.
- **FR-019**: Edit spec via $EDITOR MUST prompt user whether to regenerate plan from updated spec.
- **FR-020**: When a spec is re-approved after any modification (comment or edit), the system MUST regenerate both the plan and the task list from the updated spec before proceeding.
- **FR-021**: Pressing [b] during plan review MUST navigate back to spec review, displaying the current spec for re-review.
- **FR-022**: Pressing [b] during the review gate MUST navigate back to plan review, displaying the current plan for re-review.
- **FR-023**: The review gate MUST display a numbered summary of all tasks (title and dependency count), the current permission mode, the configured planner and implementer, and action options.

#### TLDR Changesets

- **FR-024**: When sending a regeneration prompt to the planner (spec or plan comment), the system MUST append an instruction requesting the planner produce a TLDR marker summarizing what changed.
- **FR-025**: The system MUST parse `<!-- TLDR ... -->` markers from planner output. The parser MUST extract the content between TLDR and the closing marker.
- **FR-026**: Each parsed TLDR MUST be emitted as a TuiEvent and MUST be rendered as a ChangesCard in the conversation flow, visually distinct from planner and implementer cards.
- **FR-027**: On first-time generation of a spec or plan (not a regeneration), the system MUST NOT emit a changeset event, even if the planner output happens to contain a TLDR marker.

#### Dialog-Style TUI

- **FR-028**: Event cards MUST use box-drawing characters for visual borders (top: corner + horizontal repeated + corner, sides: vertical, bottom: corner + horizontal + corner).
- **FR-029**: All labels MUST use ASCII text tags — [PLAN], [IMPL], [SPEC], [REVIEW], [CHANGES]. The TUI MUST NOT render emoji or Unicode symbol characters in labels.
- **FR-030**: Flow transitions between phases MUST render directional arrow indicators: down-arrow for forward transitions (planner to implementer), up-arrow for backward transitions (escalation back to planner).
- **FR-031**: Pass/fail indicators MUST use ASCII characters only: `*` for pass, `x` for fail.
- **FR-032**: The color scheme MUST be: planner output in blue/cyan, implementer output in green, escalation in yellow, error in red, git operations in gray.
- **FR-033**: When a task completes successfully, its event cards MUST collapse into a single summary line showing: pass/fail indicator, task number, task title, method (local or escalated), and elapsed time.
- **FR-034**: Validation results MUST render as a sub-section inside the implementer event card for that task. Validation MUST NOT produce separate top-level event cards.

#### Task-Level Control

- **FR-035**: In `supervised` mode, before each task implementation, the system MUST display a task preview card containing the task title, description, dependencies, and target file(s). The card MUST offer: Enter (implement), `s` (skip), `e` (edit task description).
- **FR-036**: In `supervised` mode, after each task implementation and validation, the system MUST display a result card containing the diff summary and validation outcome. The card MUST offer: Enter (commit), `d` (full diff), `r` (retry), `s` (skip), `e` (edit file).
- **FR-037**: The retry action MUST discard all file changes from the current implementation attempt and MUST re-run implementation from scratch.
- **FR-038**: The skip action MUST discard all file changes from the current task and MUST advance the workflow to the next task. The skipped task MUST be recorded in the final summary.
- **FR-039**: In `normal` and `auto` modes, task-level preview and result approval prompts MUST be skipped entirely.

#### Keyboard and Slash Commands

- **FR-040**: Pressing `?` at any idle prompt MUST display a help overlay listing all keyboard shortcuts available in the current context.
- **FR-041**: The help overlay MUST dismiss when any key is pressed, returning focus to the previous prompt.
- **FR-042**: Keyboard shortcuts MUST be context-sensitive. A shortcut MUST only be active when its associated action is valid for the current workflow state. Pressing an inactive shortcut MUST produce no effect.
- **FR-043**: Pressing `/` during an active workflow (at any idle prompt) MUST activate an inline slash command input with filtering.
- **FR-044**: The footer MUST display the most relevant keyboard shortcuts for the current workflow state. The footer MUST update whenever the workflow state changes.

### Key Entities

- **PermissionMode** — Represents the current approval level governing user confirmation. Four levels: supervised, normal, auto, plan-only. A workflow has exactly one active PermissionMode at any time, but the user may change it mid-workflow.

- **HomeScreen** — The initial interactive view presented when `diptych` is launched without arguments. Provides access to starting a new workflow, resuming an interrupted one, viewing status, and changing configuration.

- **ReviewGate** — A checkpoint between planning and implementation phases where the user can approve, navigate backward, or quit. Displays a full summary of tasks, mode, and configuration.

- **ChangesCard** — A summary displayed after an artifact is regenerated, showing what changed compared to the previous version. Includes a TLDR produced by the planner. One ChangesCard is produced per regeneration cycle.

- **TaskPreview** — The pre-implementation view of a single task in supervised mode. Shows the task description, target files, and dependencies, allowing the user to approve, skip, or edit before implementation begins.

- **TaskResult** — The post-implementation view of a completed task in supervised mode. Shows the code diff, validation results, and cost. The user can commit, retry, skip, or edit the file.

- **SlashCommand** — A user-invokable action triggered by typing "/" followed by a command name in the input prompt. SlashCommands are contextual — the available set depends on the current phase.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Users can start a workflow without memorizing CLI syntax — launching `diptych` with no arguments presents an interactive home screen with discoverable options.
- **SC-002**: Users can discover all available actions through the interface itself — every keyboard shortcut and slash command is visible or accessible via a help overlay at any point in the workflow.
- **SC-003**: Users can change permission level at any point during a workflow without restarting — mode switching is available from any phase.
- **SC-004**: Spec and plan feedback loops complete without losing user edits or context — commenting on, editing, or requesting regeneration of an artifact preserves all prior conversation history and user inputs.
- **SC-005**: Users can navigate backward through planning phases (e.g., from plan approval back to spec approval) and downstream artifacts are regenerated when upstream changes.
- **SC-006**: After each regeneration, users can see a summary of what changed (TLDR changeset card) within 2 seconds of the new artifact being ready.
- **SC-007**: Planner output and implementer output are visually distinguishable through different card styles, so users always know which AI produced a given response.
- **SC-008**: In supervised mode, users can review every task before implementation begins and approve, skip, or escalate every code change before it is committed.
- **SC-009**: All existing CLI commands (`start`, `spec`, `init`, `status`, `resume`) continue to work with their current arguments and behavior — the new UX is additive, not breaking.
- **SC-010**: Permission mode changes take effect within one action of the change — no buffered operations execute under the old mode.
- **SC-011**: The interface renders correctly and remains usable on terminals 80 columns wide and 24 rows tall or larger.
- **SC-012**: Task completion rate and orchestration correctness are unaffected by the UX changes — the underlying workflow logic (retry, escalation, validation) is unchanged.

## Assumptions

1. **Backwards compatibility is mandatory** — Existing CLI behavior (positional subcommands, config file format, state file format) must remain unchanged. The home screen and new UX features are additive and opt-in via the no-argument entry point.

2. **Ink 5.x supports the required TUI capabilities** — Box-drawing characters, full-width layouts, keyboard event handling, and dynamic component rendering are all supported within Ink 5.x and @inkjs/ui without requiring additional terminal libraries.

3. **Minimum terminal size is 80x24** — The layout will target 80 columns as the minimum width and 24 rows as the minimum height. Narrower or shorter terminals may produce degraded but non-broken output.

4. **Box-drawing characters render correctly in modern terminals** — Unicode box-drawing characters are assumed to render correctly in all target terminal emulators (iTerm2, Terminal.app, Windows Terminal, GNOME Terminal, and common SSH clients).

5. **Planners can produce TLDR summaries** — All supported planner backends can be prompted to produce a short natural-language summary of changes when regenerating an artifact. The TLDR is extracted from the planner's response, not computed independently.

6. **The existing state machine is extensible** — The 11-phase, 20-transition state machine can accommodate new transitions for back-navigation and mode switching without requiring a full redesign.

7. **PermissionMode does not persist across sessions by default** — When a workflow is resumed, it starts in the mode specified in the config file (or the default normal mode), not the mode that was active when the workflow was interrupted.

8. **Slash commands do not conflict with user input** — The "/" prefix is reserved for commands and will not appear as the first character of legitimate feature descriptions.

9. **Regeneration replaces artifacts wholesale** — When the user navigates back and triggers regeneration, the planner produces a complete new artifact rather than a patch.

10. **Single-user, single-session model** — Only one TUI session interacts with a given `.diptych/` directory at a time. Concurrent access is not supported.
