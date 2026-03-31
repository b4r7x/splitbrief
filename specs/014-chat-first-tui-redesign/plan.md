# Implementation Plan: Chat-First TUI Redesign

**Branch**: `014-chat-first-tui-redesign` | **Date**: 2026-03-31 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/014-chat-first-tui-redesign/spec.md`

## Summary

Complete visual overhaul of tiny-spec's terminal interface: replace workflow-only CLI with an interactive, fullscreen, chat-first experience. Three-screen architecture (home → workflow → summary) with ANSI terminal-adaptive theme, toggleable sidebar, persistent multiline input bar replacing modal prompts, review-mode for specs/plans with $EDITOR integration, and session management.

## Technical Context

**Language/Version**: TypeScript 5.9+, ESM only
**Primary Dependencies**: Ink 6.8, React 19, @inkjs/ui 2.x, Shiki 4.x, ansis, cfonts (new), fullscreen-ink (new), ink-multiline-input (new)
**Storage**: JSON files (`.tiny-spec/sessions/`, `.tiny-spec/state.json`)
**Testing**: Vitest, Ink test utilities
**Target Platform**: macOS (primary), Linux (secondary)
**Project Type**: CLI tool with TUI
**Performance Goals**: No perceptible input lag with 200+ events; 30 FPS cap
**Constraints**: Zero classes, ESM with .js extensions, all colors from theme.ts
**Scale/Scope**: ~15 UI components, 3 screens, 1 custom hook per major feature

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | PASS | No changes to planner/implementer split or token costs |
| II. Spec-Driven Development | PASS | Following speckit workflow; no workflow changes |
| III. Local-First Implementation | PASS | No new cloud dependencies |
| IV. Functional Purity | PASS | Zero classes; pure functions; ESM with .js extensions |
| V. Validate Before Commit | PASS | Validation pipeline unchanged |
| VI. Identity & Anti-Goals | PASS | Beautiful visualization IS product identity (Constitution v1.3.0). Chat-first UI exposes planner/implementer collaboration more clearly. |

**Gate result**: PASS. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/014-chat-first-tui-redesign/
├── plan.md              # This file
├── research.md          # Phase 0: dependency research, integration patterns
├── data-model.md        # Phase 1: Session, Screen, Theme entities
├── quickstart.md        # Phase 1: end-to-end usage guide
├── contracts/
│   └── cli-commands.md  # Modified CLI interface, input bar commands, keyboard shortcuts
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── cli.ts                    # MODIFY — feature arg optional, --no-fullscreen, fullscreen render
├── app.tsx                   # REWRITE — screen router, delegates to screen components
├── types.ts                  # MODIFY — add Screen, Session, ThemeMode, RouteData types
├── config.ts                 # MODIFY — add theme, shikiTheme, sessions config fields
├── theme.ts                  # REWRITE — dual mode (terminal ANSI / mono hex), no syntax section
├── engine/                   # NO CHANGES — clean engine/UI separation preserved
│   ├── orchestrator.ts       # Unchanged (callbacks stay same signature)
│   ├── highlight.ts          # MODIFY — use Shiki built-in theme from config instead of custom
│   └── ...                   # All other engine files unchanged
├── ui/
│   ├── screens/              # NEW directory
│   │   ├── home.tsx          # NEW — ASCII banner, config display, sessions, input bar
│   │   ├── workflow.tsx      # NEW — extracted from app.tsx, event flow + sidebar + input bar
│   │   └── summary.tsx       # MODIFY — extracted from summary.tsx, clean layout, navigate to home
│   ├── sidebar.tsx           # NEW — task list + cost breakdown panel
│   ├── input-bar.tsx         # NEW — persistent multiline input, slash commands, approval commands
│   ├── review-view.tsx       # NEW — scrollable markdown document view for spec/plan review
│   ├── layout.tsx            # REWRITE — fullscreen container, sidebar flexbox, no approval overlay
│   ├── event-card.tsx        # REWRITE — remove ASCII art, clean labels + whitespace
│   ├── conversation-flow.tsx # MODIFY — adapt to new event card style, spacing
│   ├── header.tsx            # MODIFY — minimalist redesign, feature + phase + time
│   ├── cost-footer.tsx       # MODIFY — clean redesign, merge with keyboard hints
│   ├── pipeline-bar.tsx      # MINOR — keep, maybe simplify styling
│   ├── task-summary.tsx      # MODIFY — cleaner collapsed line
│   ├── diff-view.tsx         # MINOR — keep, adapt colors to theme
│   ├── picker.tsx            # MINOR — reuse on home screen for config change
│   ├── prompt.tsx            # DELETE — replaced by input-bar.tsx
│   ├── question-prompt.tsx   # DELETE — replaced by input-bar.tsx
│   └── user-input.tsx        # DELETE — replaced by input-bar.tsx
├── hooks/
│   ├── use-router.ts         # NEW — screen navigation state machine
│   ├── use-sidebar.ts        # NEW — sidebar visibility + responsive auto-hide
│   ├── use-input-mode.ts     # NEW — input bar mode management (normal, review, question)
│   └── use-sessions.ts       # NEW — session CRUD (read/write/list JSON files)
└── utils/
    ├── sessions.ts           # NEW — session file I/O (read, write, list, slug)
    └── ...                   # Existing utils unchanged
```

**Structure Decision**: Follows the 013-restructure layout (engine/, ui/, hooks/, utils/). New `ui/screens/` subdirectory groups screen-level components. All other directories stay flat.

## Implementation Phases

### Phase 1: Foundation (theme, types, router)

Build the core infrastructure that everything else depends on.

**Deliverables**:
1. Rewrite `theme.ts` — dual mode (terminal/mono), remove syntax section, export `getTheme(mode)` function
2. Add new types to `types.ts` — `Screen`, `Session`, `ThemeMode`, `RouteData`, `InputMode`
3. Create `hooks/use-router.ts` — `useRouter()` hook with state machine transitions
4. Modify `config.ts` — add optional `theme`, `shikiTheme`, `sessions` fields with defaults
5. Modify `engine/highlight.ts` — read Shiki theme name from config instead of custom colors

**Tests**: Theme resolution, router transitions, config parsing with new fields.

### Phase 2: Input Bar & Review Flow

Build the unified input mechanism that replaces all modal prompts.

**Deliverables**:
1. Create `ui/input-bar.tsx` — multiline input with mode-aware behavior (normal, review, question)
2. Create `hooks/use-input-mode.ts` — manages current input mode and hint text
3. Create `ui/review-view.tsx` — scrollable markdown document renderer for spec/plan review
4. $EDITOR integration — spawn editor, detect changes, show diff summary on return
5. Slash command parsing — `/status`, `/resume`, `/init`, `/help`

**Tests**: Input submission, mode switching, slash command recognition, $EDITOR spawn/return.

### Phase 3: Screen Components

Build the three screens and wire them to the router.

**Deliverables**:
1. Create `ui/screens/home.tsx` — cfonts banner, config display with picker, sessions list, input bar
2. Create `ui/screens/workflow.tsx` — extract from app.tsx, wire orchestrator callbacks, embed input bar
3. Modify `ui/screens/summary.tsx` — extract from summary.tsx, add navigate-to-home on Enter/q
4. Create `ui/sidebar.tsx` — task list + cost panel
5. Create `hooks/use-sidebar.ts` — visibility toggle, responsive auto-hide
6. Create `hooks/use-sessions.ts` — session list/read/write
7. Create `utils/sessions.ts` — file I/O for sessions

**Tests**: Screen rendering, sidebar toggle, session persistence, home screen with/without config.

### Phase 4: Visual Redesign

Rewrite event rendering to ultra-minimalist style.

**Deliverables**:
1. Rewrite `ui/event-card.tsx` — remove all ASCII art (┃, ───, ⊘, braille), use text labels + whitespace
2. Modify `ui/conversation-flow.tsx` — adjust spacing, adapt to new card heights
3. Modify `ui/header.tsx` — minimalist: feature name + phase + elapsed time
4. Modify `ui/cost-footer.tsx` — clean single-line footer with keyboard hints
5. Modify `ui/task-summary.tsx` — cleaner collapsed task line
6. Modify `ui/diff-view.tsx` — adapt colors to new theme system

**Tests**: Event card rendering for all 11 TuiEvent types, snapshot tests for visual consistency.

### Phase 5: App Rewrite & CLI Integration

Wire everything together.

**Deliverables**:
1. Rewrite `app.tsx` — screen router as root, delegates to screen components, no direct event/approval state
2. Modify `cli.ts` — feature arg optional, `--no-fullscreen` flag, fullscreen-ink integration
3. Delete `ui/prompt.tsx`, `ui/question-prompt.tsx`, `ui/user-input.tsx`
4. Fullscreen mode — withFullScreen wrapper, CI detection, graceful shutdown
5. Wire orchestrator callbacks through workflow screen → input bar (Promise resolution)

**Tests**: Full app render, screen transitions, backward compatibility (feature as CLI arg), fullscreen enter/exit.

### Phase 6: Polish & Edge Cases

Handle fallbacks, edge cases, and final testing.

**Deliverables**:
1. cfonts fallback — plain text header if cfonts rendering fails
2. ink-multiline-input fallback — single-line TextInput if package fails
3. fullscreen-ink fallback — inline render if alt buffer fails
4. $EDITOR fallback chain — $EDITOR → vi → nano → error message
5. Terminal resize handling — reflow layout, auto-hide sidebar
6. Session cleanup — handle missing dirs, corrupt JSON, schema migration
7. Update all test imports and mocks for deleted/moved components

**Tests**: Fallback paths, resize behavior, edge case scenarios from spec.

## Dependency Graph

```
Phase 1 (Foundation)
  ↓
Phase 2 (Input Bar) ──────────> Phase 3 (Screens)
                                  ↓
                                Phase 4 (Visual)
                                  ↓
                                Phase 5 (App Rewrite)
                                  ↓
                                Phase 6 (Polish)
```

Phase 2 and Phase 3 can partially overlap — input-bar.tsx is needed by screens, but screens can be scaffolded with placeholder input while input-bar is built.

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| ink-multiline-input incompatible with Ink 6 | Medium | Fallback to custom implementation (~200 LOC) or single-line |
| fullscreen-ink blank row regression (Ink 6 #752) | Low | Account for -1 row in height calculation |
| cfonts ESM import issues | Low | Fallback to plain text banner |
| Approval callback timing | Medium | Keep same Promise-based contract; input bar resolves it |
| Large event count performance | Low | Already using incrementalRendering + Static; add virtual scroll if needed |

## Complexity Tracking

No constitution violations. No complexity justifications needed.
