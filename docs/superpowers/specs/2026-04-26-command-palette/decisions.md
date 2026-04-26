# Decisions

## ADR-001 — Keybinding: Ctrl+K Only for v1; `:` Deferred

**Status:** accepted

### Context

The task description lists both `Ctrl+K` and `:` as possible triggers. `Ctrl+K` is already registered in `src/hooks/use-app-keys.ts:82` and in `src/core/slash-commands/keybindings.ts` under id `'command-palette'`. The `:` binding would open the palette instead of inserting a literal colon in the text input, which requires the input to be in 'normal' mode with no text already typed — matching vi-style command mode.

### Decision

v1 uses `Ctrl+K` only. The keybinding already fires globally when no overlay is open. No new binding code is written in this spec; Brief 04 confirms correctness and tests the gating, not the binding itself. `:` is deferred to a follow-up spec after UX feedback.

### Consequences

- Simpler Brief 04 scope.
- No ambiguity with text input that starts with `:`.
- The `command-palette` shortcut id is already in `keybindings.ts`; Brief 04 verifies the existing entry and adds no new shortcuts.

---

## ADR-002 — Result Sources: 6 Sources, Displayed with Group Labels

**Status:** accepted

### Context

The palette must surface a unified list across heterogeneous sources. Implementing agents need exact source definitions and action semantics.

### Decision

Six sources, listed in priority order within the results when query is empty (MRU items always float above):

| # | Source key | How collected | Action on select |
|---|---|---|---|
| 1 | `slash` | `createCommands(ctx)` filtered to `validScreens` includes current screen | call `cmd.handler(undefined)` for arg commands, `cmd.handler()` for noarg |
| 2 | `mode` | 4 fixed entries: `instant`, `quick`, `standard`, `speckit` | `ctx.setWorkflowMode(mode)` |
| 3 | `picker` | 4 fixed entries: planner, implementer, sessions, settings | `ctx.openOverlay(target)` |
| 4 | `task` | `tasksStore.get().tasks` — live task list, only when phase is `implementing`, `validating-task`, or `escalating` (mirrors `canRedoTask` in `catalog.ts`) | show feedback message with task id and title; v1 does not scroll the conversation |
| 5 | `session` | last 10 sessions from `listSessions(projectDir)` (existing loader used by sessions picker) | `handleSelect(session)` from `src/features/sessions/picker-select.ts` |
| 6 | `custom` | `config.palette?.customActions ?? []` — user-defined slash command strings | `executeSlashCommand(commands, action.command, screen, feedbackStore.setError)` |

When query is empty the list shows all sources in the above order, newest MRU entries first.

### Consequences

- Task source is empty (silently) outside implementing phase — no error.
- Session source does async I/O on palette open; result is awaited before first render.
- Custom actions are strings that reference existing slash commands — no new execution surface.

---

## ADR-003 — Fuzzy Algorithm: Pure Subsequence Match with Position Weighting

**Status:** accepted

### Context

The `fzf` package is already used in `src/core/slash-commands/fuzzy.ts` and `dispatch.ts` for slash command name matching. The palette needs to search *across multiple fields* (name + description + source label) and score results uniformly. Adding a fuzzy dependency for a second purpose would couple two concerns. The rule "no new npm deps" is also in force.

### Decision

Implement pure subsequence-match in `src/utils/fuzzy-match.ts`. The algorithm:

1. **Subsequence check**: a query character sequence `q[0..n]` matches a target string `t` if every `q[i]` appears in `t` in order (arbitrary gaps allowed). Case-insensitive.
2. **Score formula** (higher is better, range 0–1):
   - `baseScore = matchedCharCount / targetLength` — coverage
   - `positionBonus = 1 - (firstMatchIndex / targetLength)` — earlier matches rank higher
   - `consecutiveBonus = consecutiveRunLength / matchedCharCount` — runs of consecutive matched chars
   - `wordBoundaryBonus`: add `0.1` for each matched char that starts at a word boundary (preceded by space, `-`, `_`, or start of string)
   - `finalScore = (baseScore * 0.4) + (positionBonus * 0.3) + (consecutiveBonus * 0.2) + (wordBoundaryBonus * 0.1)`, clamped to `0..1`
3. **No match** returns `null`.
4. **Multi-field search**: the aggregator passes `[name, description, sourceLabel].join(' ')` as the target; the matcher does not need to know about fields.

The existing `fzf` usage in `dispatch.ts` is untouched — it handles slash command *name* lookup from keyboard input, which is a different code path.

### Consequences

- Zero new dependencies.
- Algorithm is fully testable with deterministic inputs.
- Score formula is explicit — implementing agents cannot diverge.
- `fzf` for slash command dispatch remains; no regression.

---

## ADR-004 — Extended Search Syntax: Space-Separated All-Must-Match

**Status:** accepted

### Context

Power users want to narrow results by typing multiple terms (e.g. `rev spec` to find "Revise Spec"). This is the fzf extended syntax most users know.

### Decision

Split the query on whitespace: `query.trim().split(/\s+/).filter(Boolean)`. Every non-empty term must independently subsequence-match the combined target string. The item score is the sum of individual term scores. If any term fails to match, the item is excluded entirely.

Empty query → all items included with score `0` (ordering falls back to MRU rank then source priority).

### Consequences

- Simple: no special syntax characters needed.
- Deterministic — easy to test with multi-term queries.
- Single space mid-query is treated as a term separator, not a literal space.

---

## ADR-005 — MRU Persistence: Process-Lifetime Only (No Disk)

**Status:** accepted

### Context

Persisting MRU across process restarts requires either a new file under `.diptych/` or piggybacking on an existing file. The value added by cross-restart MRU is low for a v1 palette; implementation complexity is disproportionate.

### Decision

MRU is in-memory only, scoped to the running process. The store (`src/stores/ui/palette-mru.ts`) holds a `string[]` of result IDs (up to `MAX_PALETTE_MRU = 20`) in most-recently-used order. On process restart the list is empty. This is explicitly not "per workflow session" (which is an overloaded term here) — it is *process-scoped*.

### Consequences

- No new file paths in `src/core/paths.ts`.
- No disk I/O in palette code paths.
- MRU resets on restart — acceptable for v1.
- Disk persistence can be added in a follow-up spec by writing/reading from `.diptych/palette-mru.json`.

---

## ADR-006 — Custom User Actions Config Schema

**Status:** accepted

### Context

Users want to bind short names to existing slash commands they use often. The config already has extension points (`hooks`, `otel`, `codebase`). The new field should follow the same top-level object pattern.

### Decision

Add an optional `palette` field to `ConfigSchema`:

```yaml
palette:
  customActions:
    - id: "myredo"
      label: "Redo last task"
      description: "Run /redo-task T001 without typing"
      command: "/redo-task T001"
```

Zod schema (added to `src/core/schemas/config.ts`):

```ts
const PaletteCustomActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  command: z.string().startsWith('/'),
});

const PaletteConfigSchema = z.object({
  customActions: z.array(PaletteCustomActionSchema).optional(),
});
```

The `command` field must be a slash command string (starts with `/`). On selection, the aggregator calls `executeSlashCommand(commands, action.command, screen, onError)` from `src/core/slash-commands/dispatch.ts`. No new shell execution surface is introduced.

### Consequences

- Config backwards-compatible: `palette` field is optional.
- Custom actions use the existing slash command dispatch — all phase guards and screen guards apply.
- No new validation or security boundary needed.

---

## ADR-007 — Modal Overlay: Closes on Selection

**Status:** accepted

### Context

Two options: modal (closes after each selection) or sticky (stays open for multi-action). The cost-drilldown-overlay is dismissed on any key. The sessions picker closes on selection. The pattern is consistent: overlays close after serving their purpose.

### Decision

Palette closes on selection (`overlayStore.close()` before calling the action) and on Esc. It does not stay open. This matches the existing `FilterableList` + `overlayStore.close()` pattern in the old `command-palette.tsx` stub.

### Consequences

- Consistent with all other overlays.
- Users who want to run multiple actions must reopen the palette each time (Ctrl+K is one key).

---

## ADR-008 — Conflict Resolution: Source Prefix in Result Row

**Status:** accepted

### Context

Two sources can have items with identical labels (e.g., a custom action named "Help" and the `/help` slash command, or a session named "settings" and the settings picker).

### Decision

Each `PaletteResult` carries a `source` field typed as `'slash' | 'mode' | 'picker' | 'task' | 'session' | 'custom'`. The component renders a dim source badge in the result row (e.g. `[slash]`, `[session]`). The fuzzy score and action are always taken from the individual item — there is no deduplication; both items appear and the user picks the one they want. The source badge provides enough context to distinguish them.

### Consequences

- No deduplication logic to maintain.
- User sees all matching items regardless of source.
- Source badge makes the origin clear.

---

## ADR-009 — Component Location: `src/features/workflow/` Not `src/components/overlays/`

**Status:** accepted

### Context

`src/components/overlays/command-palette.tsx` already exists as a thin stub using `FilterableList` with substring-only filtering. The new component needs store subscriptions, session loading, and MRU integration that make it a feature-level component, not a generic UI primitive.

### Decision

The new implementation lives at `src/features/workflow/components/command-palette-overlay.tsx`. The stub at `src/components/overlays/command-palette.tsx` is deleted by the implementing agent of Brief 03. The app's overlay renderer (wherever it currently mounts `CommandPalette` from the old location) must be updated to mount the new component instead.

The agent implementing Brief 03 must grep for all import sites of the old path and update them.

### Consequences

- Feature-level concern lives in `features/`.
- Old stub is removed — no two palette components coexist.
- Engine code in `src/engine/palette/` must not import the feature-level component.
