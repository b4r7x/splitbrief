# 02 — Result Aggregator

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

**Brief 02 of 5** — Command Palette spec, 2026-04-26.
Depends on Brief 01 (fuzzy matcher) being merged first.

## Intent

Create a pure aggregation function `buildPaletteResults` in `src/engine/palette/aggregate.ts` that merges six result sources, applies fuzzy scoring, applies MRU ranking, and returns a sorted list of `PaletteResult` items. This is engine code — it must not import React, Ink, or anything under `src/features/` or `src/components/`.

## Scope

**In bounds:**
- `src/engine/palette/aggregate.ts` (new file)
- `src/engine/palette/aggregate.test.ts` (new file)

**Out of bounds:**
- Do not touch the fuzzy matcher (Brief 01).
- Do not touch stores, config schemas, or UI components.
- Do not import React, Ink, stores, or `src/features/`.
- Do not add npm dependencies.

## Code Context

Read before writing:

- `src/utils/fuzzy-match.ts` — the `fuzzyMatchExtended` function you will call
- `src/core/slash-commands/types.ts` — `CommandPaletteItem`, `SlashCommandDef`
- `src/core/slash-commands/dispatch.ts` — `toPaletteItems` adapter (shows shape of slash command items)
- `src/features/sessions/picker-select.ts` — `handleSelect` (action for session items — you will accept a pre-built action callback, not import this directly)
- `src/core/schemas/session.ts` — `Session` type
- `src/stores/workflow/tasks.ts` — `SidebarTask` shape (your input type for task items)

## Shared Types (define in `src/engine/palette/aggregate.ts`)

```ts
export type PaletteSource = 'slash' | 'mode' | 'picker' | 'task' | 'session' | 'custom';

export type PaletteResult = {
  id: string;           // stable unique identifier for MRU tracking
  label: string;
  description: string;
  source: PaletteSource;
  shortcut: string | null;
  score: number;        // fuzzy score, used only for sorting
  mruRank: number;      // 0 = not in MRU; 1 = most recent, 2 = second-most-recent, etc.
  action: () => void;
};
```

## Implementation Plan

### Input type

```ts
export type PaletteInputs = {
  query: string;
  // Slash command items — already converted by toPaletteItems() in the caller
  slashItems: CommandPaletteItem[];
  // Mode entries — caller builds these
  modeItems: Array<{ label: string; description: string; action: () => void }>;
  // Picker entries — caller builds these
  pickerItems: Array<{ label: string; description: string; action: () => void }>;
  // Tasks — from tasksStore; caller passes empty array when not in implementing phase
  taskItems: Array<{ id: string; title: string; action: () => void }>;
  // Sessions — last 10, caller fetches them
  sessionItems: Array<{ id: string; feature: string; status: string; action: () => void }>;
  // Custom actions from config
  customItems: Array<{ id: string; label: string; description: string; action: () => void }>;
  // MRU list — IDs in recency order (most recent first). Passed in; aggregator does not read the store.
  mruIds: string[];
};
```

### Function signature

```ts
export function buildPaletteResults(inputs: PaletteInputs): PaletteResult[];
```

### Algorithm

1. **Normalise query**: `const terms = query.trim()` (do not split here — `fuzzyMatchExtended` handles splitting internally).

2. **Build candidate list**: convert each source group into `PaletteResult[]` with a stable `id`, explicit `label`, and `description`:

   | Source | id | label | description |
   |---|---|---|---|
   | `slash` | `slash:${item.label}` | `item.label` | `item.description` |
   | `mode` | `mode:${item.label}` | `item.label` | `item.description` |
   | `picker` | `picker:${item.label}` | `item.label` | `item.description` |
   | `task` | `task:${item.id}` | `item.title` | `` `Task ${item.id}` `` |
   | `session` | `session:${item.id}` | `item.feature` | `item.status` |
   | `custom` | `custom:${item.id}` | `item.label` | `item.description` (empty string if absent) |

   Source-priority order (slash → mode → picker → task → session → custom) must be the append order so stable sort preserves it when scores are equal.

3. **Score**: for each candidate, build a search target string:
   `const target = [result.label, result.description, result.source].join(' ')`
   Call `fuzzyMatchExtended(terms, target)`.
   - If query is empty (after trim), all items pass with `score = 0`.
   - If query is non-empty and match returns `null`, exclude the item.
   - Otherwise set `result.score = matchResult.score`.

4. **MRU rank**: look up `result.id` in `mruIds`. If found, `mruRank = mruIds.indexOf(id) + 1` (1 = most recent). Otherwise `mruRank = 0`.

5. **Sort** (stable, descending priority):
   - MRU items (mruRank > 0) sort above non-MRU items.
   - Within MRU items, sort by ascending `mruRank` (1 first).
   - Within non-MRU items, sort descending by `score`.
   - Tie-break: ascending alphabetical by `result.label`.

6. Return the sorted array.

### Source ordering within empty query

When query is empty, all items pass with `score = 0` and no MRU. The source-priority order from ADR-002 is preserved by stable sort (slash first, then mode, picker, task, session, custom) — ensure candidates are appended in that order before sorting.

## Validation

### Test cases (colocated in `src/engine/palette/aggregate.test.ts`)

- Empty query returns all items from all sources, in source-priority order.
- Non-matching query returns empty array.
- Matching query returns only matched items, sorted by score descending.
- MRU items appear first regardless of score.
- Within MRU, most-recently-used item comes first.
- Non-MRU items sorted by score; within same score, alphabetical by label.
- Stable id format: `slash:Help`, `mode:instant`, `picker:settings`, `task:T001`, `session:<uuid>`, `custom:myredo`.
- Item excluded when `fuzzyMatchExtended` returns null.
- When query is empty, all items included (no exclusions).
- `mruRank` of 1 set for id at index 0 in mruIds; 0 for ids not in mruIds.
- Custom items with no description default to empty string in the target string (no crash).

## Constraints

- No React, Ink, store, or `src/features/` imports.
- No `class` keyword.
- No barrel exports.
- ESM `.js` import suffixes.
- The function is pure (given the same inputs, always returns the same output). Actions are opaque callbacks — the aggregator does not call them.
- Do not sort stably by mutating input arrays — use `[...arr].sort(...)`.

## Escalation

If the `fuzzyMatchExtended` import fails typecheck (e.g., Brief 01 not yet merged), block on that first. Do not work around it with `any`.

## Evidence Requirements

- `npm test -- src/engine/palette/aggregate.test.ts` passes.
- `npm run typecheck` passes.
- `npm run lint` passes.
- All test cases from the Validation section are present and passing.
