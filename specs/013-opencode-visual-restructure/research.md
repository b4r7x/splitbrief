# Research: OpenCode Visual Restructure

**Branch**: `013-opencode-visual-restructure`
**Date**: 2026-03-31
**Sources**: 9 parallel research agents covering Ink 6 migration, Shiki integration, opencode visual design, codebase mapping

## 1. Ink 5 → 6 Migration

### Decision: Upgrade to Ink 6.8.0 + React 19

**Rationale**: Only 2 breaking changes — Node 20+ (already have 22+) and React 19. No API removals. Ink 6 adds `backgroundColor` on Box (v6.1.0), `incrementalRendering` (v6.5.0), `maxFps` (v6.3.0), `synchronizedOutput` (v6.7.0 automatic), and `<Static>` behavior unchanged.

**Alternatives considered**:
- Stay on Ink 5 — rejected: no `backgroundColor` on Box (critical for depth effect), no incremental rendering
- OpenTUI — rejected: requires Bun runtime (FFI), v0.1.x maturity, major migration. Future option.
- @jrichman/ink fork — rejected: upstream Ink 6.5+ has native incremental rendering now

### Migration details

Package changes:
```
ink:          ^5.2.0  →  ^6.8.0
react:        ^18.3.0 →  ^19.0.0
@types/react: ^18.0.0 →  ^19.0.0
@inkjs/ui:    ^2.0.0  →  (unchanged, already compatible with ink>=5)
```

Render call:
```tsx
render(<App />, {
  incrementalRendering: true,
  maxFps: 30,
})
```

React 19 changes affecting us:
- `forwardRef` deprecated (still works) — `ConversationFlow` uses it, can simplify later
- `ref` is now a regular prop
- Context can be used as provider directly
- No breaking hook changes for useState/useEffect/useCallback/useMemo

### backgroundColor on Box

Added in Ink v6.1.0. Accepts: hex (`#1a1a2e`), `rgb(r,g,b)`, `ansi256(n)`, color names. Fills content area with colored spaces. Works for 3-level depth effect.

Known limitation: issue #731 reports edge cases in some scenarios, closed "not planned". Should test our specific layout.

### Static component

Unchanged from Ink 5. Items rendered via `<Static>` are written permanently above dynamic content and never re-rendered. Only new items appended to the array render — previously rendered items are write-once. Perfect for completed task summaries.

### ANSI pass-through in Text

Ink preserves SGR sequences (color/style codes ending with `m`) inside `<Text>`. Shiki output (SGR codes via ansis) renders correctly. Caveat: don't combine `<Text color="...">` props with pre-colored ANSI children — use plain `<Text>`.

---

## 2. Shiki Syntax Highlighting

### Decision: Fine-grained Shiki bundle + custom theme + ansis

**Rationale**: `@shikijs/cli`'s `codeToANSI` only accepts bundled theme names, not custom themes. Building our own 15-line ANSI converter using `codeToTokensBase` + `ansis` is trivial and gives full control over theme colors.

**Alternatives considered**:
- `@shikijs/cli` with `codeToANSI` — rejected: can't use custom theme object
- chalk instead of ansis — rejected: ansis is lighter and used by Shiki internally
- Manual regex-based highlighting — rejected: fragile, poor quality vs real parser

### Implementation approach

Dependencies: `shiki` (v4.x), `ansis`

Fine-grained imports (minimal bundle):
```ts
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
// Languages loaded via dynamic import:
import('@shikijs/langs/typescript')
import('@shikijs/langs/javascript')
```

Custom theme using TextMate format with opencode-inspired colors:
- keyword: `#9d7cd8` (purple/accent)
- function: `#fab283` (peach/primary)
- string: `#7fd88f` (green/success)
- variable: `#e06c75` (red/error)
- type: `#e5c07b` (yellow)
- operator: `#56b6c2` (cyan/info)
- comment: `#808080` (muted)
- punctuation: `#eeeeee` (text)

### Performance

| Operation | Time |
|-----------|------|
| Fine-grained init (first call) | ~5ms |
| Subsequent init (cached) | ~1ms |
| Per-call highlight (100 lines TS) | ~4-5ms |

At 30fps (33ms budget), a single highlight is well within budget. Cache highlighted ANSI strings keyed by `lang:code` — don't re-highlight unchanged code.

### Integration with Ink

```tsx
// CORRECT: plain Text, ANSI codes pass through
<Text>{highlightedAnsiString}</Text>

// WRONG: color prop wraps and overrides ANSI
<Text color="white">{highlightedAnsiString}</Text>
```

---

## 3. OpenCode Visual Design Specification

### Decision: Replicate opencode's visual language in Ink

**Rationale**: opencode has the best-looking terminal UI in the coding assistant space. Its design principles (background stepping, left accents, no borders on cards) are achievable in Ink 6.

### Visual language

**No box-drawing borders on content**. Visual separation via:
1. Background color stepping (3 levels)
2. Left-colored vertical accent lines for message ownership
3. Spacing (padding, gap)

**Color palette** (opencode default dark theme):

| Token | Hex | Usage |
|-------|-----|-------|
| background | `#0a0a0a` | Main background (near-black) |
| backgroundPanel | `#141414` | Panels, user messages, sidebar |
| backgroundElement | `#1e1e1e` | Input field, code blocks |
| borderSubtle | `#3c3c3c` | Subtle separators |
| border | `#484848` | Normal borders |
| borderActive | `#606060` | Active/focused borders |
| primary | `#fab283` | Warm peach — functions, accents |
| secondary | `#5c9cf5` | Blue — secondary highlights |
| accent | `#9d7cd8` | Purple — headings, keywords |
| text | `#eeeeee` | Main text (near white) |
| textMuted | `#808080` | Secondary text, hints, comments |
| success | `#7fd88f` | Green — passed, strings |
| error | `#e06c75` | Red — failed, variables |
| warning | `#f5a742` | Orange — retry, numbers |
| info | `#56b6c2` | Cyan — operators, links |
| yellow | `#e5c07b` | Types, emphasis |

**Diff colors**:

| Element | Foreground | Background |
|---------|-----------|------------|
| Added | `#4fd6be` | `#20303b` |
| Removed | `#c53b53` | `#37222c` |
| Context | `#828bb8` | `#141414` |

### Component visual patterns

**User messages**: Left accent line (`┃` or colored `│`) in primary, backgroundPanel bg
**Tool calls**: Compact 1-line: ` . description (result)` in textMuted, expandable
**Planner text**: Markdown — headings in accent, code highlighted, bold in warning
**Spinner**: Braille (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) at 80ms, primary color
**Footer**: Keyboard hints in textMuted, cost in text, separated by `│`
**Pipeline bar**: `●` green (done), `◉` primary (active), `○` muted (pending)

---

## 4. Codebase Migration Map

### Decision: Rename `orchestrator/` → `engine/`, `tui/` → `ui/` (flat), keep utils/

**Rationale**: 48 source files total. No duplicates in the original structure (failed restructure attempt is stashed). Clean 1:1 mapping.

### File count by category

| Category | Files | Target |
|----------|-------|--------|
| Entry | 2 | `src/cli.ts`, `src/app.tsx` |
| Types | 1 | `src/types.ts` |
| Engine | 25 | `src/engine/` |
| UI | 12 | `src/ui/` (flat) |
| Utils | 5 | `src/utils/` |
| Config/State | 2 | `src/config.ts`, `src/state.ts` |

### Migration map

```
src/orchestrator/orchestrator.ts      →  src/engine/orchestrator.ts
src/orchestrator/implementer.ts       →  src/engine/implementer.ts
src/orchestrator/validator.ts         →  src/engine/validator.ts
src/orchestrator/escalator.ts         →  src/engine/escalator.ts
src/orchestrator/planner-detection.ts →  src/engine/detection.ts
src/orchestrator/providers.ts         →  src/engine/providers.ts
src/orchestrator/pricing.ts           →  src/engine/pricing.ts
src/orchestrator/diff.ts              →  src/utils/diff.ts
src/orchestrator/context-extractor.ts →  src/engine/context-extractor.ts
src/orchestrator/extractor.ts         →  src/engine/extractor.ts
src/orchestrator/claude-stream.ts     →  src/engine/claude-stream.ts
src/orchestrator/question-parser.ts   →  src/engine/question-parser.ts
src/orchestrator/implementers/shell.ts  →  src/engine/implementers/shell.ts
src/orchestrator/implementers/agent.ts  →  src/engine/implementers/agent.ts
src/orchestrator/planners/*           →  src/engine/planners/*
src/spec/*                            →  src/engine/spec/*
src/tui/*                             →  src/ui/* (flat, 12 files)
src/utils/*                           →  src/utils/* (unchanged)
src/config.ts                         →  src/config.ts (unchanged)
src/state.ts                          →  src/state.ts (unchanged)
src/types.ts                          →  src/types.ts (unchanged)
src/cli.ts                            →  src/cli.ts (unchanged)
src/app.tsx                           →  src/app.tsx (unchanged)
```

### New files to create

```
src/ui/theme.ts                       ← Theme object (colors, syntax, diff)
src/engine/highlight.ts               ← Shiki singleton + codeToAnsi helper
```

### Test files (24 unit + 6 integration)

All import paths need updating: `orchestrator/` → `engine/`, `tui/` → `ui/`, `spec/` → `engine/spec/`.

---

## 5. Project Structure Validation

### Decision: engine/ + ui/ (flat) + hooks/ + utils/ — not Bulletproof React

**Rationale**: Bulletproof React features pattern assumes independent domains. diptych's TUI is one cohesive view (~12 components), not 4 independent features. Feature folders add overhead (barrel exports, cross-feature imports) without benefit at this scale.

**Alternatives considered**:
- Bulletproof React (`features/conversation/`, `features/input/`, etc.) — rejected: forced artificial boundaries, 4 folders with 3 files each
- Flat everything — rejected: engine and UI have different concerns, separation aids testing
- Monorepo (packages/) — rejected: overkill for 48 files

### Final target structure

```
src/
├── cli.ts                          # Entry point (unchanged)
├── app.tsx                         # Root Ink component (update imports)
├── types.ts                        # All shared types (unchanged)
├── config.ts                       # Config loading (unchanged)
├── state.ts                        # State machine (unchanged)
├── engine/                         # Business logic (zero React)
│   ├── orchestrator.ts
│   ├── implementer.ts
│   ├── validator.ts
│   ├── escalator.ts
│   ├── detection.ts
│   ├── providers.ts
│   ├── pricing.ts
│   ├── context-extractor.ts
│   ├── extractor.ts
│   ├── claude-stream.ts
│   ├── question-parser.ts
│   ├── highlight.ts                # NEW: Shiki singleton
│   ├── implementers/
│   │   ├── shell.ts
│   │   └── agent.ts
│   ├── planners/
│   │   ├── factory.ts
│   │   ├── types.ts
│   │   ├── claude-code.ts
│   │   ├── codex.ts
│   │   ├── opencode.ts
│   │   ├── aider.ts
│   │   ├── agent-sdk.ts
│   │   └── shell.ts
│   └── spec/
│       ├── parser.ts
│       ├── formatter.ts
│       └── templates.ts
├── theme.ts                        # NEW: Theme object (project-level, no React deps)
├── ui/                             # Ink components (flat)
│   ├── layout.tsx
│   ├── header.tsx
│   ├── pipeline-bar.tsx
│   ├── conversation-flow.tsx
│   ├── cost-footer.tsx
│   ├── event-card.tsx
│   ├── diff-view.tsx
│   ├── prompt.tsx
│   ├── user-input.tsx
│   ├── question-prompt.tsx
│   ├── summary.tsx
│   ├── task-summary.tsx
│   └── picker.tsx
├── hooks/
│   ├── use-workflow.ts
│   └── use-app-navigation.ts
└── utils/
    ├── git.ts
    ├── fs.ts
    ├── format.ts
    ├── process.ts
    ├── diff.ts                     # moved from orchestrator/
    └── version.ts
```
