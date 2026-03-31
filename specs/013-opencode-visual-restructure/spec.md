# Feature Specification: OpenCode Visual Restructure

**Feature Branch**: `013-opencode-visual-restructure`
**Created**: 2026-03-31
**Status**: Draft
**Input**: Clean slate project restructure with opencode-like visual TUI design, Ink 6 upgrade, Shiki syntax highlighting, and new engine/ui/hooks architecture

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Visually polished TUI experience (Priority: P1)

A developer runs `tiny-spec start "add user auth"` and sees a polished terminal interface that feels comparable to opencode: near-black background with layered depth through background color stepping, left-colored accent lines on messages, compact inline tool call displays, syntax-highlighted code in diffs, and braille spinners during processing. The planner/implementer collaboration is visible as a natural conversation flow with clear visual hierarchy — no box-drawing borders on content cards, just spacing and color contrast.

**Why this priority**: The TUI is the product's face. Users judge quality by what they see. A polished visual directly communicates that tiny-spec is a serious tool, not a weekend project.

**Independent Test**: Run `tiny-spec start` with a mock workflow, visually compare output against opencode screenshots — background stepping, accent lines, tool call formatting, diff rendering, and spinner animations should all be present and visually cohesive.

**Acceptance Scenarios**:

1. **Given** a terminal with truecolor support, **When** the user launches tiny-spec, **Then** the interface shows layered backgrounds (3 depth levels: main, panel, element) with no box-drawing borders on content cards.
2. **Given** a planner message arrives, **When** it renders in the conversation flow, **Then** planner text appears as conversational markdown with headings in accent color and code blocks with syntax highlighting.
3. **Given** an implementer generates code, **When** the tool call renders, **Then** it shows as a compact single-line format (icon + description + stats) in muted color, expandable to show full diff with syntax-highlighted additions/removals.
4. **Given** a user message is displayed, **When** it renders, **Then** it has a left accent line in the primary color and a slightly lighter background than the main area.
5. **Given** a long-running operation, **When** the spinner renders, **Then** braille spinner characters cycle at ~80ms intervals in the primary color.

---

### User Story 2 - Syntax-highlighted diffs and code blocks (Priority: P1)

When the implementer generates code or the planner shows code examples, the output includes full syntax highlighting using the project's theme palette. Diffs show added lines in teal on dark teal background and removed lines in red on dark red background, matching opencode's diff color scheme. Code blocks in planner markdown output are highlighted by language.

**Why this priority**: Syntax highlighting is table stakes for a coding tool. Without it, code is unreadable walls of text. This directly impacts the user's ability to review generated code.

**Independent Test**: Generate a TypeScript diff through the implementer and verify that keywords, strings, types, operators, and comments each render in distinct colors matching the theme palette.

**Acceptance Scenarios**:

1. **Given** an implementer completes a task with code changes, **When** the user expands the diff view, **Then** added lines show syntax-highlighted code on a tinted background, removed lines show syntax-highlighted code on a different tinted background, and context lines appear in muted color.
2. **Given** the planner outputs markdown with a TypeScript code block, **When** it renders in the conversation flow, **Then** the code block has syntax highlighting matching the active theme's syntax colors.
3. **Given** the user is on a terminal without truecolor support, **When** code renders, **Then** highlighting degrades gracefully to 256-color or basic ANSI without crashing.

---

### User Story 3 - Flicker-free incremental rendering (Priority: P2)

The TUI updates smoothly without full-screen redraws. When new events arrive (planner text streaming, tool call completion, validation results), only the changed lines update. Completed tasks that collapse to summary lines stop being re-rendered entirely. The experience feels fluid even with dozens of events in the conversation flow.

**Why this priority**: Flickering undermines trust in the tool. Users associate visual glitches with buggy software. Incremental rendering is the foundation for a polished experience.

**Independent Test**: Run a workflow that generates 50+ events, observe that the terminal does not flash/flicker during updates, and that scroll performance remains smooth.

**Acceptance Scenarios**:

1. **Given** the TUI is running with incremental rendering enabled, **When** a new event arrives, **Then** only the affected lines redraw — the header, completed events, and footer remain stable.
2. **Given** 30+ events have been emitted, **When** the user scrolls through the conversation, **Then** scrolling is smooth with no visible tearing or flicker.
3. **Given** a task completes and collapses to a summary line, **When** subsequent events arrive, **Then** the collapsed summary line is never re-rendered.

---

### User Story 4 - Clean project structure (Priority: P2)

The codebase is reorganized into a clear separation: `engine/` for all business logic (zero React dependencies), `ui/` for all Ink components (flat folder), `hooks/` for the bridge between engine and UI, and `utils/` for pure helpers. A developer new to the project can understand where things live within 30 seconds of looking at the file tree.

**Why this priority**: The current 3-layer overlap (old structure + core + features/lib) makes the codebase unmaintainable. Clean structure is prerequisite for sustainable development.

**Independent Test**: Run `tree src/ -L 2` and verify the output matches the documented structure with no overlapping directories, no duplicate files, and clear naming.

**Acceptance Scenarios**:

1. **Given** the restructured codebase, **When** a developer looks at `src/engine/`, **Then** they find all business logic (orchestrator, planners, implementer, validator, escalator, spec parsing) with zero React/Ink imports.
2. **Given** the restructured codebase, **When** a developer looks at `src/ui/`, **Then** they find a flat folder with all Ink components (~15 files), each focused on a single visual concern.
3. **Given** the restructured codebase, **When** a developer runs `npx tsc --noEmit`, **Then** there are zero compilation errors — all imports resolve correctly with `.js` extensions.
4. **Given** the restructured codebase, **When** a developer runs `npm test`, **Then** all existing tests pass with import paths updated.

---

### User Story 5 - Theme system with opencode-inspired defaults (Priority: P3)

The TUI uses a theme object that defines all colors used in the interface: backgrounds (3 levels), borders, text (normal + muted), primary/secondary/accent, semantic colors (success/error/warning/info), syntax highlighting colors, and diff colors. The default theme matches opencode's dark palette. The theme is a plain object — no runtime theme switching needed for v1, but the structure supports adding themes later.

**Why this priority**: Centralized colors prevent hardcoded hex values scattered across components. A single source of truth makes the visual design maintainable and changeable.

**Independent Test**: Change the primary color in the theme object and verify it propagates to all components that use it — header, accent lines, spinner, active pipeline stage.

**Acceptance Scenarios**:

1. **Given** the theme object, **When** a component needs a color, **Then** it imports from the theme — no hardcoded color strings in component files.
2. **Given** the default theme, **When** the TUI renders, **Then** the visual palette matches the opencode dark theme: near-black background, panel background, element background, warm peach primary, purple accent.

---

### User Story 6 - Upgraded framework foundation (Priority: P3)

The project runs on Ink 6.x with React 19, enabling incremental rendering, synchronized output, configurable FPS, and concurrent rendering support. Shiki is integrated as a singleton highlighter for TypeScript/JavaScript syntax highlighting via ANSI output.

**Why this priority**: Framework upgrade is infrastructure — it enables P1 and P2 stories but delivers no visible value alone.

**Independent Test**: Verify dependencies are at target versions. Run the app with incremental rendering enabled without errors. Call the Shiki highlighter and verify ANSI output renders in Ink.

**Acceptance Scenarios**:

1. **Given** the upgraded dependencies, **When** the app starts, **Then** Ink 6 renders with incremental rendering enabled and configurable FPS.
2. **Given** Shiki is initialized, **When** a code string is highlighted, **Then** it returns an ANSI-escaped string that renders correctly inside Ink text components.
3. **Given** the Shiki highlighter, **When** it initializes, **Then** it loads only TypeScript and JavaScript languages with a single theme, keeping startup time minimal.

---

### Edge Cases

- What happens when the terminal does not support truecolor? Colors degrade to 256-color or basic ANSI without errors.
- What happens when terminal width is very narrow (<60 columns)? Layout adapts — long text wraps, pipeline bar abbreviates stage names.
- What happens when terminal height is very short (<10 rows)? Footer and header remain visible, content area shrinks to minimum.
- What happens when Shiki fails to initialize (e.g., missing grammar)? Code renders as plain unhighlighted text with a warning logged.
- What happens when hundreds of events accumulate? Completed tasks collapse to single lines via static rendering, only active events are in the dynamic render tree.

## Requirements *(mandatory)*

### Functional Requirements

**Visual Design**

- **FR-001**: TUI MUST use background color stepping (3 levels) instead of box-drawing borders for visual separation between sections.
- **FR-002**: Approval prompts and user input areas MUST display with a left accent line in the primary color and a panel-level background.
- **FR-003**: Tool calls MUST render as compact single-line entries (icon prefix + description + result) in muted color, with keyboard-driven expansion to show full output.
- **FR-004**: Diff views MUST show syntax-highlighted additions and removals with tinted backgrounds (teal-tinted for additions, red-tinted for removals).
- **FR-005**: Pipeline progress bar MUST use colored dots (done=green, active=primary, pending=muted) with stage labels.
- **FR-006**: Spinner MUST use braille characters cycling at ~80ms in the primary color.
- **FR-007**: Footer MUST display cost breakdown, task progress, model name, and keyboard hints in muted color.
- **FR-008**: Planner text MUST render a minimal markdown subset: headings (# prefix → accent bold), fenced code blocks (→ syntax highlighted), bold (**text** → warning color), emphasis (*text* → italic). Tables, links, images, and nested lists are out of scope for v1.

**Syntax Highlighting**

- **FR-009**: System MUST integrate a syntax highlighting engine that outputs ANSI-escaped strings for terminal display.
- **FR-010**: Syntax highlighting MUST support at minimum TypeScript and JavaScript languages.
- **FR-011**: The highlighter MUST initialize once as a singleton and be reused across all rendering calls.
- **FR-012**: Highlighting MUST use the theme's syntax color palette (keyword, function, string, variable, type, operator, comment each in distinct colors).

**Rendering Performance**

- **FR-013**: System MUST use line-level incremental rendering per FR-027.
- **FR-014**: Completed conversation events MUST be rendered via a static mechanism that excludes them from re-render cycles.
- **FR-015**: Render frame rate MUST be configurable, defaulting to 30 FPS.

**Project Structure**

- **FR-016**: All business logic MUST reside in `src/engine/` with zero React/Ink dependencies.
- **FR-017**: All Ink/React UI components MUST reside in `src/ui/` as a flat directory.
- **FR-018**: Shared React hooks bridging engine state to UI MUST reside in `src/hooks/`.
- **FR-019**: Pure utility functions MUST reside in `src/utils/`.
- **FR-020**: All shared type definitions MUST reside in a single `src/types.ts` file.
- **FR-021**: All imports MUST use `.js` extensions per ESM conventions.
- **FR-022**: All existing tests MUST pass after restructure with import paths updated.

**Theme System**

- **FR-023**: All colors used in the TUI MUST be sourced from a centralized theme object — no hardcoded color values in component files.
- **FR-024**: The default theme MUST implement the opencode dark palette (3-level backgrounds, warm peach primary, purple accent, semantic colors).
- **FR-025**: The theme object MUST include sections for: backgrounds, borders, text, primary/secondary/accent, semantic, syntax, and diff colors.

**Framework Upgrade**

- **FR-026**: System MUST run on Ink 6.x with React 19.
- **FR-027**: Ink render call MUST enable incremental rendering and synchronized output.

### Key Entities

- **Theme**: Centralized color palette object with background levels, accent colors, semantic colors, syntax colors, and diff colors. Single source of truth for all visual styling.
- **TuiEvent**: Union type representing all possible conversation events (planner text, tool calls, validation results, git commits, errors, escalation). Unchanged from current design — visual rendering changes, data model stays.
- **Highlighter**: Singleton syntax highlighting engine instance, initialized once at startup, producing ANSI-escaped strings from source code.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero hardcoded color values exist in any UI component file — all colors reference the theme object.
- **SC-002**: All existing unit tests pass after restructure (zero regressions).
- **SC-003**: TypeScript compilation produces zero errors.
- **SC-004**: Code diffs display with at least 8 distinct syntax colors (keyword, function, string, variable, type, operator, comment, punctuation).
- **SC-005**: The `src/engine/` directory has zero imports from `react`, `ink`, or any UI library.
- **SC-006**: The `src/ui/` directory contains all components as direct children (flat structure).
- **SC-007**: Terminal output shows no visible flicker during a 50-event workflow when incremental rendering is enabled.
- **SC-008**: `src/` top-level contains exactly these subdirectories: `engine/`, `ui/`, `hooks/`, `utils/` — no others (excluding root-level .ts files).

## Assumptions

- Target terminals support truecolor (24-bit color). Degradation to 256-color is handled but not optimized for.
- The existing TuiEvent data model is sufficient — this spec changes visual rendering and project structure, not the event schema.
- Shiki's ANSI output is compatible with Ink's text rendering (ANSI escape codes pass through correctly).
- React 18 to 19 migration is straightforward for Ink apps — no breaking changes in the React API subset used by tiny-spec.
- Ink 6's static component works as documented for permanent/non-re-rendered content.
- opencode's visual design principles (background stepping, left accents, no borders) translate well to Ink's layout primitives.
- No runtime theme switching is needed for v1 — a single default dark theme is sufficient.
- The existing `cli.ts` entry point and commander setup remain unchanged — only the rendering layer and project structure change.
