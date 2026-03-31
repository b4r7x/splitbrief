# Feature Specification: TUI Interactive Fix

**Feature Branch**: `015-tui-interactive-fix`
**Created**: 2026-03-31
**Status**: Draft
**Input**: Fix broken TUI — wire up all input handlers and slash commands, implement working command handlers, center HomeScreen, fix keyboard shortcuts, add command palette and help overlay, enable rendering optimizations.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Working Input & Commands (Priority: P1)

A developer launches tiny-spec and types a feature description into the home screen chatbox. The text is accepted, and the app transitions to the workflow screen where the feature is being processed. The developer can also type slash commands like `/help` or `/status` at any time and get meaningful responses.

**Why this priority**: The app is currently non-functional — no input produces any result. Without working input, nothing else matters.

**Independent Test**: Can be fully tested by launching the app, typing a feature description, and verifying the workflow starts. Then typing `/help` and verifying a help overlay appears.

**Acceptance Scenarios**:

1. **Given** the app is on the home screen, **When** the user types a feature description and presses Enter, **Then** the app navigates to the workflow screen with that feature.
2. **Given** the app is on any screen, **When** the user types `/help`, **Then** a help overlay appears showing all available commands and keyboard shortcuts.
3. **Given** the app is on the home screen, **When** the user types `/status`, **Then** the current workflow state is displayed (or "no active workflow" if idle).
4. **Given** the app is on the home screen, **When** the user types `/init`, **Then** the interactive planner/implementer picker is triggered.
5. **Given** the app is on any screen, **When** the user types an invalid slash command, **Then** a brief error message is shown inline (not silently swallowed).

---

### User Story 2 - Professional Home Screen (Priority: P2)

A developer launches tiny-spec with `npm run start` (no arguments). The home screen loads with a vertically centered layout: ASCII banner at the top, configuration summary, recent sessions list, and an input bar at the bottom. The layout feels polished, balanced, and professional — similar to OpenCode's welcome screen.

**Why this priority**: First impressions define perceived quality. A centered, well-spaced home screen makes the tool feel production-ready.

**Independent Test**: Can be fully tested by launching the app in terminals of different widths (80, 120, 200 columns) and verifying the layout is centered and readable in each.

**Acceptance Scenarios**:

1. **Given** the user runs the app without arguments, **When** the home screen loads, **Then** the content is vertically and horizontally centered in the terminal.
2. **Given** the terminal is 80 columns wide, **When** the home screen loads, **Then** all content fits without wrapping or overflow.
3. **Given** the terminal is 200 columns wide, **When** the home screen loads, **Then** the content remains centered, not left-aligned against the edge.
4. **Given** previous sessions exist, **When** the home screen loads, **Then** sessions are displayed in a clean list with status icons, feature names, and relative timestamps.

---

### User Story 3 - Command Palette (Priority: P3)

While using tiny-spec on any screen, the developer presses Ctrl+K to open a command palette overlay. The palette lists all available commands and keyboard shortcuts. The developer can type to filter commands and press Enter to execute one, or Escape to dismiss.

**Why this priority**: Command palette is the standard discoverability pattern for keyboard-driven tools. It replaces the need to memorize slash commands.

**Independent Test**: Can be fully tested by pressing Ctrl+K on any screen and verifying the overlay appears with a filterable list of commands.

**Acceptance Scenarios**:

1. **Given** the app is on any screen, **When** the user presses Ctrl+K, **Then** a command palette overlay appears on top of the current content.
2. **Given** the command palette is open, **When** the user types a filter string, **Then** the command list is filtered in real time.
3. **Given** the command palette is open, **When** the user selects a command and presses Enter, **Then** the command executes and the palette closes.
4. **Given** the command palette is open, **When** the user presses Escape, **Then** the palette closes without executing anything.

---

### User Story 4 - Sidebar Integration (Priority: P4)

During a workflow, the developer sees a sidebar on the left showing the task list and cost metrics. The sidebar appears automatically on wide terminals (100+ columns) and can be toggled with a keyboard shortcut. The shortcut does not conflict with common editor shortcuts.

**Why this priority**: The sidebar already exists in code but is disconnected. Wiring it up provides valuable context during workflows.

**Independent Test**: Can be fully tested by running a workflow in a wide terminal (120+ cols) and verifying the sidebar appears. Then pressing the toggle shortcut and verifying it hides/shows.

**Acceptance Scenarios**:

1. **Given** the terminal is 100+ columns wide, **When** the workflow screen loads, **Then** the sidebar is visible on the left showing task list and cost metrics.
2. **Given** the terminal is less than 100 columns wide, **When** the workflow screen loads, **Then** the sidebar is hidden.
3. **Given** the sidebar is visible, **When** the user presses the sidebar toggle shortcut, **Then** the sidebar hides and the main content expands.
4. **Given** the sidebar is hidden, **When** the user presses the sidebar toggle shortcut, **Then** the sidebar appears (if terminal width permits).

---

### User Story 5 - Help Overlay (Priority: P5)

At any point, the developer presses `?` or types `/help` to see a help overlay that lists all available keyboard shortcuts, slash commands, and their descriptions. The overlay is dismissable with Escape.

**Why this priority**: Users currently have no way to discover available shortcuts and commands. This completes the discoverability story alongside the command palette.

**Independent Test**: Can be fully tested by pressing `?` and verifying a comprehensive help overlay appears.

**Acceptance Scenarios**:

1. **Given** the app is on any screen, **When** the user types `/help` or presses `?`, **Then** a help overlay appears listing all commands and shortcuts.
2. **Given** the help overlay is open, **When** the user presses Escape, **Then** the overlay closes.
3. **Given** the help overlay is open, **Then** it displays: all slash commands with descriptions, all keyboard shortcuts with descriptions, and grouped by category (navigation, workflow, display).

---

### Edge Cases

- What happens when the user types a slash command that's valid but not available on the current screen? Display an inline message like "command not available here".
- What happens when the terminal is resized while the command palette is open? The palette should reposition to remain centered.
- What happens when the user presses Ctrl+K while a review prompt is active? The command palette should not open during review mode (review input takes priority).
- What happens when the user presses `?` while typing in the input bar? The `?` character should be inserted normally, not trigger help. Help via `?` only triggers when input bar is not focused or is empty.

## Requirements *(mandatory)*

### Functional Requirements

**Input & Command Handling**

- **FR-001**: The app MUST accept text input on the home screen and start a workflow with that text as the feature description.
- **FR-002**: The app MUST support slash commands (`/help`, `/status`, `/init`) on the home screen.
- **FR-003**: The app MUST support slash commands (`/help`, `/status`) on the workflow and summary screens.
- **FR-004**: Invalid or unavailable slash commands MUST display an inline error message to the user, not be silently ignored.
- **FR-005**: The `/help` command MUST display a help overlay with all available commands and shortcuts.
- **FR-006**: The `/status` command MUST display the current workflow state (phase, task progress, elapsed time) or "no active workflow" if idle.
- **FR-007**: The `/init` command MUST trigger the interactive planner/implementer configuration picker.

**Home Screen Layout**

- **FR-008**: The home screen content MUST be horizontally centered in the terminal.
- **FR-009**: The home screen content MUST be vertically distributed with balanced spacing (banner, config, sessions, input).
- **FR-010**: The home screen MUST display correctly on terminals from 80 to 250 columns wide without overflow or wrapping of core content.

**Command Palette**

- **FR-011**: The app MUST provide a command palette accessible via Ctrl+K on any screen.
- **FR-012**: The command palette MUST display as an overlay on top of current content.
- **FR-013**: The command palette MUST support real-time text filtering of the command list.
- **FR-014**: The command palette MUST be dismissable via Escape.
- **FR-015**: Selecting a command in the palette MUST execute it and close the palette.

**Keyboard Shortcuts**

- **FR-016**: Keyboard shortcuts MUST NOT conflict with common terminal emulator or code editor shortcuts (Cmd+B, Ctrl+B are explicitly excluded).
- **FR-017**: The sidebar toggle MUST use a non-conflicting shortcut (e.g., Ctrl+S, Tab, or a custom key determined during planning).
- **FR-018**: The `/quit` command MUST gracefully exit the application.

**Sidebar**

- **FR-019**: The workflow screen MUST display the existing sidebar component on terminals 100+ columns wide.
- **FR-020**: The sidebar MUST be toggleable via keyboard shortcut.
- **FR-021**: The sidebar MUST auto-hide when the terminal shrinks below 100 columns and auto-show when it expands above 100 columns (if previously visible).

**Help Overlay**

- **FR-022**: The app MUST provide a help overlay accessible via `/help` or `?` key.
- **FR-023**: The help overlay MUST list all slash commands with descriptions.
- **FR-024**: The help overlay MUST list all keyboard shortcuts with descriptions.
- **FR-025**: The help overlay MUST be dismissable via Escape.

**Rendering Optimizations**

- **FR-026**: The app MUST enable synchronized output to prevent visual flicker in terminal multiplexers.

### Key Entities

- **SlashCommand**: A named command (e.g., `/help`) with a handler function, valid screens list, and description for display in help/palette.
- **Overlay**: A modal UI layer (help, command palette) rendered on top of the current screen, dismissable via Escape.
- **CommandPaletteItem**: An entry in the command palette with a label, description, shortcut hint, and action callback.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can type a feature description and start a workflow within 5 seconds of launching the app (no CLI arguments needed).
- **SC-002**: 100% of defined slash commands (`/help`, `/status`, `/init`) produce visible output when executed on their valid screens.
- **SC-003**: Zero keyboard shortcut conflicts with VS Code, Zed, or standard macOS terminal shortcuts.
- **SC-004**: Home screen content appears centered on terminals from 80 to 250 columns wide.
- **SC-005**: Command palette opens within 200ms of pressing Ctrl+K and filters results as the user types.
- **SC-006**: All existing unit tests continue to pass after changes.
- **SC-007**: The sidebar displays on terminals 100+ columns wide during workflow execution.

## Assumptions

- The existing sidebar component (`src/ui/sidebar.tsx`) and sidebar hook (`src/hooks/use-sidebar.ts`) are functionally correct and only need wiring into the workflow screen.
- The `incrementalRendering` option is already enabled in the render call; only `synchronizedOutput` needs to be added.
- The `?` key for help only triggers when the input bar is not actively receiving text input (to avoid interfering with typing).
- Ctrl+K is safe across macOS Terminal, iTerm2, Zed terminal, and VS Code terminal — it is not bound to a conflicting action in these environments.
- The help overlay and command palette are new components that need to be created from scratch.
- The existing `useInput` hook from Ink provides sufficient keyboard event handling for all required shortcuts.
