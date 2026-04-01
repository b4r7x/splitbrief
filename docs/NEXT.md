# What to Work on Next

**Last updated**: 2026-03-31
**Branch**: `013-opencode-visual-restructure`
**Context**: Load `/tiny-spec-dev` skill first, then read this file.

## What Just Happened (v0.5)

Clean slate visual restructure completed:

1. **Ink 5 → 6.8** + React 18 → 19 — incremental rendering, synchronized output, backgroundColor on Box
2. **Project restructure** — `orchestrator/` → `engine/`, `tui/` → `ui/` (flat), new `hooks/`, `theme.ts`
3. **OpenCode-inspired visuals** — background color stepping (3 levels), left accent lines, compact tool calls, braille spinners
4. **Shiki syntax highlighting** — TypeScript/JavaScript code in diffs and planner markdown, custom theme with opencode palette
5. **`<Static>` for completed events** — zero re-render cost for finished tasks
6. **404 tests pass**, zero TSC errors, zero hardcoded colors in UI

### Architecture Decision: engine/ + ui/ (not Bulletproof React)

We tried Bulletproof React (features/conversation/, features/input/, features/layout/, features/workflow/) and rejected it. Why:

- tiny-spec's TUI is **one cohesive view** with ~14 components, not 4 independent features
- Feature boundaries were artificial — `features/conversation/` imported from `features/workflow/` constantly
- 4 folders with 3 files each = overhead, not organization

Instead: `engine/` (25 files, zero React) + `ui/` (14 files, flat) + `hooks/` (2 files) + `theme.ts`. Clean, simple, honest about what this project is.

### Architecture Decision: theme.ts at project root

Theme lives at `src/theme.ts` (not `src/ui/theme.ts`) because:
- `engine/highlight.ts` needs syntax colors for the Shiki TextMate theme
- Putting theme in `ui/` would create an `engine/ → ui/` dependency, violating the zero-UI-deps rule
- Theme is data (hex strings), not UI — it belongs alongside `types.ts` as shared project-level config

### Architecture Decision: useResponsiveLayout hook (not Context)

Terminal dimensions flow through `useResponsiveLayout()` → `{ cols, rows, isSmall, isMedium, isLarge }`. Screens derive specific values (sidebar width, content width, truncation lengths) locally.

**Why hook, not Context:** 3 screens + 2 UI components consume dimensions. Context adds a provider wrapper and indirection for what is a simple useState + resize listener. Migration to Context is trivial if the app grows to 10+ consumers — the interface stays the same.

**Key handling (two-tier):**
- Global (`use-global-keys.ts`): Ctrl+C/K/Q//, Escape — all screens
- Screen-local (e.g. `workflow.tsx` useInput): Ctrl+\, Ctrl+D, arrows — screen-specific
- `shortcuts.ts` is metadata-only for help overlay display

### Visual Design: Why OpenCode

opencode has the best terminal UI in AI coding tools. Its design achieves polish through **simple, replicable patterns**:

| Pattern | How opencode does it | How we do it (Ink 6) |
|---------|---------------------|----------------------|
| Depth | 3-level bg stepping (#0a0a0a → #141414 → #1e1e1e) | `backgroundColor` on `<Box>` (Ink 6.1+) |
| Message ownership | Left colored `┃` accent line | `<Text color={theme.accent}>┃</Text>` + content |
| Tool calls | Compact 1-line with icon (`. description result`) | Same pattern in event-card.tsx |
| Code | Shiki syntax highlighting | `codeToTokensBase` + `ansis` → ANSI in `<Text>` |
| Borders | None on content — spacing + color contrast only | Removed all `borderStyle` from content cards |
| Spinner | Braille frames at 80ms | `useState` + `setInterval` |

What we **can't** match (and it's fine):
- opencode uses OpenTUI (Zig native, 60fps) — we use Ink 6 with line-level incremental rendering
- opencode has mouse support — we use keyboard (`d` for diff, arrows for scroll)
- opencode has CSS-like animations — we have frame-based braille spinners

## Priority Order

1. **End-to-end battle-test** — Run the full pipeline with real Claude Code + Ollama to validate new visuals in practice
2. **Fix test script** — `npm test` glob `tests/**/*.test.ts` only matches subdirectory files. Should be `tests/*.test.ts` or include both patterns
3. **Demo mode** — Add a way to preview the TUI with mock events without needing planner/implementer
4. Token dashboard, integration tests
5. Multi-language support (beyond TypeScript/JavaScript)

## Key Files to Understand

| File | What it does | Why it matters |
|------|-------------|----------------|
| `src/theme.ts` | Color palette — opencode dark theme | Single source of truth for all colors. Change one value, propagates everywhere. |
| `src/engine/highlight.ts` | Shiki singleton + ANSI output | Syntax highlighting for diffs and code blocks. Custom TextMate theme from theme.ts. |
| `src/ui/event-card.tsx` | Renders TuiEvent as visual card | The heart of the visual design. Switch on event type → sub-components with themed rendering. |
| `src/ui/conversation-flow.tsx` | Scrollable event list | Uses `<Static>` for completed tasks, dynamic render for active events. Windowing logic. |
| `src/engine/orchestrator.ts` | Main workflow loop | Emits `TuiEvent`s consumed by the UI. No React deps. |

## What Changed in the Restructure

```
BEFORE (v0.4)                    AFTER (v0.5)
─────────────────                ────────────────
src/orchestrator/  (25 files)  → src/engine/      (25 files, zero React)
src/tui/           (13 files)  → src/ui/           (14 files, flat, all themed)
src/spec/          (3 files)   → src/engine/spec/  (3 files)
src/types.ts       (unchanged)   src/types.ts
src/config.ts      (unchanged)   src/config.ts
src/state.ts       (unchanged)   src/state.ts
                    NEW:         src/theme.ts       (color palette)
                    NEW:         src/engine/highlight.ts (Shiki)
                    NEW:         src/hooks/          (workflow + navigation)
```

## Conversation History Summary

The owner wants tiny-spec to feel alive — to show the planner/implementer collaboration visually. Not another multi-agent coordinator, but a cost optimizer with a TUI that makes you feel the savings happening in real-time. The opencode-inspired redesign replaces the old dual-pane raw text layout AND the failed Bulletproof React attempt with a clean, beautiful conversation flow.
