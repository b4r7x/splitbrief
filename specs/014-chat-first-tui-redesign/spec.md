# Feature Specification: Chat-First TUI Redesign

**Feature Branch**: `014-chat-first-tui-redesign`
**Created**: 2026-03-31
**Status**: Draft
**Input**: Complete visual overhaul of the terminal interface, replacing the workflow-only view with an interactive, fullscreen, chat-first experience inspired by OpenCode's design philosophy.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Interactive Home Screen (Priority: P1)

A developer launches tiny-spec without any arguments. They see a welcoming home screen with an ASCII art banner, their current planner and implementer configuration, and a list of recent sessions. They type a feature description into the input bar at the bottom and press Ctrl+Enter to begin the workflow.

**Why this priority**: Without a home screen, the tool requires CLI arguments to function. This is the gateway to the entire chat-first experience and the most fundamental change from the current design.

**Independent Test**: Can be fully tested by launching `npm run start` with no arguments and verifying the home screen renders with banner, config display, and functional input bar.

**Acceptance Scenarios**:

1. **Given** the user has a configured project, **When** they run `tiny-spec` with no arguments, **Then** they see a home screen with ASCII banner, current planner/model config, recent sessions, and an input bar
2. **Given** the user is on the home screen, **When** they type a feature description and press Ctrl+Enter, **Then** the app transitions to the workflow screen with that feature
3. **Given** the user has no config file, **When** they launch the app, **Then** the home screen shows an inline picker for planner/model selection before accepting input
4. **Given** the user is on the home screen, **When** they select "change" next to planner or model, **Then** an inline picker opens allowing them to switch configuration

---

### User Story 2 - Ultra-Minimalist Workflow View (Priority: P2)

During a workflow, the developer sees planner output, implementer progress, validation results, and git commits rendered as clean, label-based event cards with generous whitespace. No ASCII art decorations. The visual hierarchy comes from spacing and layout, not from symbols or excessive color.

**Why this priority**: The workflow view is where users spend most of their time. Clean, readable rendering directly impacts the perceived quality of the tool and makes the planner/implementer collaboration visible and satisfying.

**Independent Test**: Can be tested by running a workflow and verifying all event types render with text labels, consistent spacing, and no ASCII art symbols.

**Acceptance Scenarios**:

1. **Given** a workflow is running, **When** the planner emits text, **Then** it renders with a "planner" label and the associated phase, using only whitespace and color for hierarchy
2. **Given** the implementer is generating code, **When** the event card renders, **Then** it shows "implementer" label, file name, and a simple progress indicator — no braille spinners or box-drawing characters
3. **Given** validation completes, **When** the result card renders, **Then** it shows "validator" label with pass/fail status per stage using minimal iconography
4. **Given** a task completes, **When** it collapses, **Then** it shows a single clean line with task number, title, method, and duration

---

### User Story 3 - Terminal-Adaptive Theme (Priority: P3)

A developer using Catppuccin, Dracula, Solarized, or any other terminal theme launches tiny-spec. The interface automatically uses colors from their terminal palette, looking native and cohesive. Alternatively, a developer who prefers a specific look can switch to the built-in "mono" theme with hand-picked colors.

**Why this priority**: Consistent color integration with the user's environment is what separates a polished tool from a kitschy one. This addresses the core visual quality complaint.

**Independent Test**: Can be tested by launching the app in terminals with different color schemes and verifying colors adapt, or by setting `theme: mono` in config and verifying fixed colors apply.

**Acceptance Scenarios**:

1. **Given** the user has a dark terminal theme (e.g., Dracula), **When** they launch tiny-spec with default settings, **Then** all UI colors match their terminal palette via ANSI 0-15 color codes
2. **Given** the user has a light terminal theme (e.g., Solarized Light), **When** they launch tiny-spec, **Then** the interface remains readable and visually cohesive
3. **Given** the user sets `theme: mono` in config, **When** they launch the app, **Then** the interface uses the built-in hand-picked hex color palette regardless of terminal theme
4. **Given** any theme mode, **When** rendering UI components, **Then** zero hardcoded color values exist outside of theme.ts

---

### User Story 4 - Toggleable Sidebar (Priority: P4)

During a workflow, the developer presses Ctrl+B to reveal a sidebar showing the task list with completion status and a cost breakdown panel. They press Ctrl+B again to hide it and reclaim screen width for the main content.

**Why this priority**: The sidebar provides at-a-glance workflow context without cluttering the main view. It's valuable but not essential — the footer already shows basic progress.

**Independent Test**: Can be tested by triggering Ctrl+B during a workflow and verifying the sidebar appears/disappears with correct task and cost data.

**Acceptance Scenarios**:

1. **Given** the sidebar is hidden, **When** the user presses Ctrl+B, **Then** a sidebar appears on the right showing task list and cost breakdown
2. **Given** the sidebar is visible, **When** the user presses Ctrl+B, **Then** the sidebar hides and the main content expands to full width
3. **Given** the terminal is narrower than 100 columns, **When** the user presses Ctrl+B, **Then** the sidebar does not appear (insufficient space)
4. **Given** the sidebar is visible and a task completes, **When** the task list updates, **Then** the sidebar reflects the new status in real time

---

### User Story 5 - Fullscreen Mode (Priority: P5)

The developer launches tiny-spec and it opens in a fullscreen alternate screen buffer, similar to vim or less. Their previous terminal output is preserved and restored when they exit. In CI environments, fullscreen mode is automatically disabled.

**Why this priority**: Fullscreen mode provides a professional, immersive experience. It's important for polish but the app works without it.

**Independent Test**: Can be tested by launching the app and verifying alternate screen buffer is used, then exiting and verifying terminal history is restored.

**Acceptance Scenarios**:

1. **Given** the user launches tiny-spec in an interactive terminal, **When** the app starts, **Then** it switches to the alternate screen buffer
2. **Given** the app is running in fullscreen, **When** the user exits (q or Ctrl+C), **Then** the terminal restores previous content
3. **Given** the user passes `--no-fullscreen`, **When** the app starts, **Then** it renders inline without alternate screen buffer
4. **Given** the app detects a non-interactive environment (CI, piped output), **When** starting, **Then** fullscreen mode is automatically disabled

---

### User Story 6 - Session Management (Priority: P6)

A developer who previously ran a workflow sees their recent sessions listed on the home screen. They can select one to resume it, or start a fresh workflow. Sessions are stored per-project by default, with an option for global storage.

**Why this priority**: Session management enhances the multi-use experience but isn't required for core functionality. The existing resume command already handles mid-workflow recovery.

**Independent Test**: Can be tested by running a workflow to completion, restarting the app, and verifying the session appears in the recent list with correct metadata.

**Acceptance Scenarios**:

1. **Given** the user has completed previous workflows, **When** they open the home screen, **Then** recent sessions appear with feature name, time ago, and status
2. **Given** the user selects a resumable session, **When** they choose to resume, **Then** the app transitions to the workflow screen and continues from the saved state
3. **Given** sessions are stored per-project by default, **When** the user sets `sessions.scope: global` in config, **Then** sessions are stored in and read from the global home directory
4. **Given** the user is on the home screen with sessions listed, **When** they type a new feature description, **Then** a fresh workflow starts regardless of existing sessions

---

### User Story 7 - Multiline Input (Priority: P7)

The developer types a multi-line feature description or comment. They use Enter for line breaks and Ctrl+Enter to submit. The input bar expands to accommodate multiple lines up to a maximum height.

**Why this priority**: Multiline input improves the experience for longer descriptions but single-line input is functional. This is a polish feature.

**Independent Test**: Can be tested by typing text with Enter for newlines in the input bar and verifying the input expands and Ctrl+Enter submits correctly.

**Acceptance Scenarios**:

1. **Given** the input bar is focused, **When** the user presses Enter, **Then** a new line is inserted in the input
2. **Given** the user has typed multiple lines, **When** they press Ctrl+Enter, **Then** the full multi-line text is submitted
3. **Given** the input bar has reached maximum height, **When** the user adds more lines, **Then** the input scrolls vertically within its bounds
4. **Given** the user is on the workflow screen during approval, **When** they type a comment with multiple lines, **Then** the multi-line comment is sent to the orchestrator

---

### User Story 8 - Screen Navigation with Custom Router (Priority: P3)

The developer flows naturally between three screens: home, workflow, and summary. After a workflow completes, they see the summary. From the summary, they press Enter to return home and can start another feature immediately without restarting the app.

**Why this priority**: Session-like navigation (summary back to home) is core to the chat-first experience and must work reliably for the app to feel cohesive. Shares priority with theme because both are essential for the redesigned experience.

**Independent Test**: Can be tested by completing a full home-to-workflow-to-summary-to-home cycle and verifying each transition works correctly.

**Acceptance Scenarios**:

1. **Given** the user is on the home screen, **When** they submit a feature description, **Then** the screen transitions to workflow
2. **Given** a workflow completes, **When** the orchestrator signals completion, **Then** the screen transitions to summary
3. **Given** the user is on the summary screen, **When** they press Enter or q, **Then** the screen transitions back to home
4. **Given** the user is on summary, **When** they return to home, **Then** the completed session appears in the recent sessions list

---

### Edge Cases

- What happens when the terminal is resized during a workflow? The layout must reflow, and the sidebar must auto-hide if width drops below 100 columns.
- What happens when cfonts is unavailable or the terminal doesn't support the font rendering? Fall back to plain text "tiny-spec" header.
- What happens when ink-multiline-input fails or is incompatible? Fall back to single-line input with $EDITOR support for long text.
- What happens when a user types a slash command that doesn't exist? Show "unknown command" inline, don't crash.
- What happens when session storage directory doesn't exist? Create it automatically on first session save.
- What happens when fullscreen-ink fails in an unusual terminal? Catch the error and fall back to inline rendering.
- What happens when the user passes a feature argument AND the app has a home screen? Skip home screen, go directly to workflow (backward compatible).
- What happens when `$EDITOR` is not set? Fall back to `vi`, then `nano`, then show an error suggesting the user set `$EDITOR`.
- What happens when the user edits a spec file externally (outside $EDITOR flow) during review? The TUI does not auto-detect external changes; user must type `edit` to trigger a re-read.
- What happens when the planner regenerates after a comment but the user already made manual edits? The planner output overwrites the file — manual edits are lost. The diff summary after regeneration makes this visible.

## Requirements *(mandatory)*

### Functional Requirements

**Home Screen**

- **FR-001**: System MUST display an interactive home screen when launched without a feature argument
- **FR-002**: Home screen MUST show an ASCII art banner rendered with the cfonts library
- **FR-003**: Home screen MUST display the current planner tool and implementer model configuration
- **FR-004**: Home screen MUST provide an inline picker to change planner and model without editing config files
- **FR-005**: Home screen MUST list recent sessions with feature name, relative timestamp, and status
- **FR-006**: Home screen MUST allow selecting a session to resume it

**Screen Navigation**

- **FR-007**: System MUST implement a screen router supporting three screens: home, workflow, and summary
- **FR-008**: Router MUST enforce valid transitions: home to workflow, workflow to summary, summary to home or workflow
- **FR-009**: When a feature argument is provided via CLI, the system MUST skip the home screen and go directly to workflow (backward compatibility)

**Workflow Screen**

- **FR-010**: All event cards MUST render with clean text labels ("planner", "implementer", "validator") instead of ASCII art symbols
- **FR-011**: Event cards MUST use consistent whitespace-based visual hierarchy across all event types
- **FR-012**: Completed tasks MUST collapse to a single clean summary line
- **FR-013**: System MUST provide a toggleable sidebar activated by Ctrl+B
- **FR-014**: Sidebar MUST display task list with status indicators and cost breakdown
- **FR-015**: Sidebar MUST auto-hide when terminal width is below 100 columns

**Summary Screen**

- **FR-016**: Summary screen MUST display workflow results with clean, minimal formatting
- **FR-017**: Summary screen MUST transition to home screen when user presses Enter or q

**Theme System**

- **FR-018**: Default theme ("terminal") MUST use ANSI 0-15 color codes that respect the user's terminal color scheme
- **FR-019**: Alternative theme ("mono") MUST use hand-picked hex color values for a consistent look across terminals
- **FR-020**: Theme mode MUST be configurable via `theme` field in config.yaml
- **FR-021**: All UI component colors MUST reference theme.ts exclusively — zero hardcoded color values in component files
- **FR-041**: Syntax highlighting in code blocks MUST use Shiki's built-in themes, independent of the UI theme mode
- **FR-042**: Shiki theme MUST default to github-dark and be configurable via `shikiTheme` field in config.yaml (no auto-detection — no reliable cross-platform API exists)

**Fullscreen Mode**

- **FR-022**: System MUST run in alternate screen buffer (fullscreen) by default in interactive terminals
- **FR-023**: Fullscreen MUST be disableable via `--no-fullscreen` CLI flag
- **FR-024**: System MUST auto-detect non-interactive environments (CI, piped output) and disable fullscreen

**Input Bar**

- **FR-025**: A persistent input bar MUST be visible at the bottom of every screen
- **FR-026**: Input bar MUST support multiline text entry with Enter for new lines
- **FR-027**: Input bar MUST submit on Ctrl+Enter
- **FR-028**: Input bar MUST recognize slash commands: `/status`, `/resume`, `/init`, `/help`

**Review & Approval Flow**

- **FR-033**: When approval is needed (spec or plan), the main content area MUST display the full document rendered as scrollable markdown with syntax highlighting
- **FR-034**: User MUST be able to scroll the document with arrow keys and page up/down during review
- **FR-035**: Typing `edit` or `e` in the input bar MUST open the document file in the user's `$EDITOR`; the TUI pauses while the editor is open and re-renders the updated content on return
- **FR-036**: Typing `comment <text>` in the input bar MUST send the comment to the planner for regeneration; the updated document MUST replace the previous version in the review area
- **FR-037**: Typing `approve` in the input bar MUST accept the document and continue the workflow
- **FR-038**: Typing `quit` or `q` in the input bar during review MUST abort the workflow
- **FR-039**: After returning from `$EDITOR`, the system MUST show a brief summary of what changed (e.g., lines added/removed) before resuming review
- **FR-040**: The input bar MUST replace the current modal approval prompts (prompt.tsx, question-prompt.tsx) — there is one input mechanism for all user interaction

**Session Management**

- **FR-029**: System MUST persist session metadata after each workflow run
- **FR-030**: Default session storage MUST be project-local (`.tiny-spec/sessions/`)
- **FR-031**: Global session storage (`~/.tiny-spec/sessions/`) MUST be available via `sessions.scope: global` in config
- **FR-032**: Each session record MUST contain: feature name, timestamp, completion status, and summary

### Key Entities

- **Screen**: One of three application views (home, workflow, summary) managed by the router. Contains its own render logic and input handling.
- **Theme**: A named color palette (terminal or mono) that maps semantic color roles to actual color values. All UI rendering derives colors from the active theme.
- **Session**: A record of a completed or interrupted workflow. Contains feature description, timestamps, status, and enough metadata to display in the recent sessions list or resume.
- **InputBar**: A persistent multiline text input component present on all screens. Handles text entry, slash command parsing, and submission.
- **Sidebar**: A toggleable panel showing task progress and cost metrics during workflow execution. Occupies the right portion of the screen when visible.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can launch the tool and begin a workflow in under 10 seconds without consulting documentation or remembering CLI arguments
- **SC-002**: The interface renders correctly and cohesively across at least 3 different terminal color schemes (dark, light, and a popular theme like Catppuccin)
- **SC-003**: All 11 TuiEvent types render with consistent visual formatting — no mixed styling patterns across event cards
- **SC-004**: Screen transitions (home to workflow to summary to home) complete without visual glitches or state leaks
- **SC-005**: Sidebar toggle responds within one render frame and does not cause layout reflow artifacts
- **SC-006**: The tool remains responsive (no perceptible input lag) during workflows with 30+ tasks and 200+ events
- **SC-007**: Fullscreen mode correctly restores terminal state on both clean exit and Ctrl+C interruption
- **SC-008**: Existing CLI usage (`tiny-spec start "feature"`) continues to work identically — zero breaking changes to the public interface

## Clarifications

### Session 2026-03-31

- Q: How should approval flow work with the persistent input bar — modal overlay, input bar replaces modals, or hybrid? → A: Input bar replaces modals entirely. During review, the main content area shows the full document (scrollable markdown). User types `approve`, `edit` (opens $EDITOR), `comment <text>` (sends to planner for regeneration), or `quit` in the input bar. This creates a review session loop: read → edit → comment → read → approve. No separate modal components needed.
- Q: How should syntax highlighting behave with the ANSI terminal-adaptive theme? → A: Shiki syntax highlighting is independent of theme mode. UI elements use ANSI 0-15 colors; code blocks use Shiki's built-in themes (e.g., github-dark, github-light) auto-selected based on terminal light/dark detection. The theme.ts syntax section is replaced by a Shiki theme name, not custom hex values.

## Starting Point

This feature builds on top of the completed `013-opencode-visual-restructure` branch, which already restructured the codebase from `src/orchestrator/` + `src/tui/` + `src/spec/` into the new layout:

- `src/engine/` — workflow logic (orchestrator, planners, implementer, validator, etc.)
- `src/ui/` — Ink UI components (layout, event-card, header, footer, etc.)
- `src/hooks/` — React hooks (placeholder, to be expanded)
- `src/utils/` — helpers (process, git, fs, format)
- `src/theme.ts` — centralized color palette

All engine and UI code has been moved to the new structure. Import paths are updated. Tests are updated. This redesign modifies the existing `src/ui/` and `src/hooks/` directories — it does not re-restructure the codebase.

## Assumptions

- Users have terminals that support ANSI color codes (virtually all modern terminals do)
- The cfonts npm package renders correctly in terminals with standard Unicode support (UTF-8)
- The ink-multiline-input package is compatible with Ink 6.x and React 19; if not, a custom implementation or single-line fallback will be used
- The fullscreen-ink package works with Ink 6.x; if not, fullscreen mode will be deferred
- Terminal width of 80 columns is the minimum supported — narrower terminals may have degraded layout
- The existing TuiEvent type system is sufficient for the redesigned UI and does not need new event types
- Session metadata is lightweight (under 1KB per session) and does not require a database
- The existing picker.tsx component can be adapted for inline use on the home screen without a full rewrite
- The 013 restructure (engine/, ui/, hooks/, utils/) is the starting point — no re-restructuring needed
