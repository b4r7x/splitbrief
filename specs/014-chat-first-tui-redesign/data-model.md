# Data Model: Chat-First TUI Redesign

**Date**: 2026-03-31
**Spec**: [spec.md](./spec.md)

## New Entities

### Session

A record of a completed or interrupted workflow, persisted as JSON.

**Fields**:
- `id: string` — `{timestamp}-{slug}` (e.g., `1711900800000-add-user-auth`)
- `feature: string` — original feature description
- `startedAt: number` — Unix timestamp (ms)
- `completedAt: number | null` — null if interrupted
- `status: 'complete' | 'interrupted' | 'failed'`
- `summary: Summary | null` — final workflow summary (reuses existing Summary type)
- `stateVersion: number` — for forward compatibility
- `stateFile: string | null` — relative path to workflow state snapshot (e.g., `state.json`) at time of session save, null if no resumable state

**Identity**: `id` field (timestamp + slug). Unique per project or globally depending on scope.

**Storage**: One JSON file per session. Path: `.tiny-spec/sessions/{id}.json` (project) or `~/.tiny-spec/sessions/{id}.json` (global).

### Screen

Not persisted. Runtime-only state.

**Values**: `'home' | 'workflow' | 'summary'`

**Transitions**:
```
home ──[feature submitted]──> workflow
workflow ──[orchestrator complete]──> summary
summary ──[enter/q pressed]──> home
summary ──[session resumed]──> workflow
```

**Route data** (carried between transitions):
- `home → workflow`: `{ feature: string }`
- `workflow → summary`: `{ summary: Summary }`
- `summary → home`: no data (home re-reads sessions from disk)

### ThemeMode

Not persisted separately. Read from Config.

**Values**: `'terminal' | 'mono'`

- `terminal`: ANSI 0-15 named colors (respects terminal palette)
- `mono`: Fixed hex values (Tokyo Night-inspired)

### Theme

Runtime resolved theme object. Structure:

```
{
  text: string        // default text color
  textDim: string     // secondary/muted text
  accent: string      // primary interactive color
  success: string     // pass/complete states
  error: string       // fail/abort states
  warning: string     // retries, escalations
  info: string        // informational
  planner: string     // planner role label
  implementer: string // implementer role label
  validator: string   // validator role label
  border: string      // structural lines/borders
  panelBg: string     // sidebar/header background (ANSI 256 or hex)
}
```

No `syntax` section — Shiki uses its own built-in theme independently.

## Modified Entities

### Config (existing, extended)

New optional fields:
- `theme?: 'terminal' | 'mono'` — defaults to `'terminal'`
- `shikiTheme?: string` — defaults to `'github-dark'`
- `sessions?: { scope?: 'project' | 'global' }` — defaults to `{ scope: 'project' }`

### OrchestratorCallbacks (existing, unchanged)

The `onApprovalNeeded` signature stays `Promise<{ approved: boolean; comment?: string }>`. The input bar resolves this Promise — no orchestrator changes needed.

`onQuestionAsked` also stays unchanged — the input bar handles question display and response collection.

## Unchanged Entities

- **TuiEvent** — no new event types needed. All 11 existing types cover the redesigned UI.
- **Phase** — 12 phases remain the same.
- **Summary** — reused by Session entity as-is.
- **WorkflowState** — unchanged, used for resume functionality.
