# Data Model: OpenCode Visual Restructure

**Branch**: `013-opencode-visual-restructure`
**Date**: 2026-03-31

## Entities

### Theme

Centralized color palette. Single source of truth for all visual styling. Plain object, not a class.

```
Theme
├── background: string          # Main bg (#0a0a0a)
├── backgroundPanel: string     # Panel bg (#141414)
├── backgroundElement: string   # Input/code bg (#1e1e1e)
├── border: string              # Normal border (#484848)
├── borderSubtle: string        # Subtle separator (#3c3c3c)
├── borderActive: string        # Focused border (#606060)
├── primary: string             # Warm peach (#fab283)
├── secondary: string           # Blue (#5c9cf5)
├── accent: string              # Purple (#9d7cd8)
├── text: string                # Near white (#eeeeee)
├── textMuted: string           # Gray (#808080)
├── success: string             # Green (#7fd88f)
├── error: string               # Red (#e06c75)
├── warning: string             # Orange (#f5a742)
├── info: string                # Cyan (#56b6c2)
├── yellow: string              # Yellow (#e5c07b)
├── syntax
│   ├── keyword: string         # = accent
│   ├── function: string        # = primary
│   ├── string: string          # = success
│   ├── variable: string        # = error
│   ├── type: string            # = yellow
│   ├── operator: string        # = info
│   ├── comment: string         # = textMuted
│   └── punctuation: string     # = text
└── diff
    ├── added: string           # #4fd6be
    ├── addedBg: string         # #20303b
    ├── removed: string         # #c53b53
    ├── removedBg: string       # #37222c
    ├── context: string         # #828bb8
    └── contextBg: string       # #141414
```

### TuiEvent (unchanged)

Union type of all conversation events. No changes from current implementation — only visual rendering changes.

```
TuiEvent =
  | { type: 'planner-status', phase, status, summary?, duration? }
  | { type: 'planner-text', text }
  | { type: 'task-start', taskId, index, title }
  | { type: 'task-complete', taskId, method, retries, duration }
  | { type: 'task-skipped', taskId, title, reason }
  | { type: 'implementer-generate', model?, status, file?, diff?, linesAdded?, linesRemoved?, duration? }
  | { type: 'validate', passed, stages: { tsc, lint, test }, error?, duration? }
  | { type: 'retry', taskId, attempt, maxRetries }
  | { type: 'escalate', taskId, tier, hint? }
  | { type: 'git-commit', message }
  | { type: 'error', message }
```

### Highlighter (singleton)

Syntax highlighting engine instance. Created once at startup, reused for all calls.

```
Highlighter
├── instance: HighlighterCore     # Shiki core instance (lazy init)
├── cache: Map<string, string>    # key: "lang:code", value: ANSI string
└── highlight(code, lang): string # Returns cached or freshly highlighted ANSI
```

## State Transitions

No new state transitions. The Phase type and state machine are unchanged — this spec only changes visual rendering and project layout.

## Relationships

```
Theme (src/theme.ts) ──used by──> all ui/*.tsx components
Theme (src/theme.ts) ──used by──> Highlighter (syntax colors define TextMate theme)
Highlighter (src/engine/highlight.ts) ──used by──> diff-view.tsx
Highlighter (src/engine/highlight.ts) ──used by──> event-card.tsx
TuiEvent ──consumed by──> conversation-flow.tsx → event-card.tsx

Dependency direction: theme.ts is project-level (like types.ts),
importable by both engine/ and ui/ without violating layering.
```
