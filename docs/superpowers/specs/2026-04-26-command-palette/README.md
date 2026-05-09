# Command Palette — 2026-04-26

> **Status:** draft spec.
> **Scope:** implement a fuzzy command palette that opens on Ctrl+K, unifying slash commands, mode actions, pickers, live tasks, recent sessions, and custom user actions into one searchable surface.
> **Out of scope:** replacing the existing `/command` slash-input system; it remains the primary keyboard-driven path. The palette is an *alternative* entry point layered on top. Persistent MRU across process restarts (disk storage). The `:` alternative binding is deferred (ADR-001 explains why).

## Purpose

With 50+ slash commands and actions reachable only by typing `/name`, discoverability collapses as the catalog grows. The palette gives every action a searchable name, a source label, and a keyboard shortcut hint — without removing the existing slash input flow.

The `'command-palette'` entry in `OverlayType` and the `Ctrl+K` keybinding in `use-app-keys.ts` already exist as stubs. This spec implements the missing component, aggregation layer, fuzzy matcher, and MRU store.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Human overview |
| 2 | `decisions.md` | ADRs — read before any brief |
| 3 | `agent-briefs/00-coordinator.md` | Execution order and shared invariants |
| 4 | `agent-briefs/01-fuzzy-matcher.md` | Pure subsequence match in `src/utils/fuzzy-match.ts` |
| 5 | `agent-briefs/02-result-aggregator.md` | `buildPaletteResults` in `src/engine/palette/aggregate.ts` |
| 6 | `agent-briefs/03-palette-component.md` | `src/features/workflow/components/command-palette-overlay.tsx` |
| 7 | `agent-briefs/04-keystroke-binding.md` | Confirm existing Ctrl+K binding; wire `:` input gating |
| 8 | `agent-briefs/05-mru-and-custom-actions.md` | In-memory MRU store + config schema for custom user actions |

## Change Set

| # | Brief | Files Affected |
|---|---|---|
| 01 | Fuzzy Matcher | `src/utils/fuzzy-match.ts` (new), `src/utils/fuzzy-match.test.ts` (new) |
| 02 | Result Aggregator | `src/engine/palette/aggregate.ts` (new), `src/engine/palette/aggregate.test.ts` (new) |
| 03 | Palette Component | `src/features/workflow/components/command-palette-overlay.tsx` (new), delete `src/components/overlays/command-palette.tsx` (stub replaced) |
| 04 | Keystroke Binding | `src/hooks/use-app-keys.ts` (confirm/adjust), `src/features/workflow/hooks/use-workflow-keys.ts` (confirm), `src/core/slash-commands/keybindings.ts` (confirm) |
| 05 | MRU + Custom Actions | `src/stores/ui/palette-mru.ts` (new), `src/stores/ui/palette-mru.test.ts` (new), `src/core/schemas/config.ts` (extend), `src/core/slash-commands/context.ts` (extend) |

## Key Pre-existing Artifacts

These exist and must be understood before touching anything:

- `src/components/overlays/command-palette.tsx` — existing stub using `FilterableList` + substring match. **Brief 03 supersedes this file; the implementing agent must delete it.**
- `src/hooks/use-app-keys.ts:82` — `Ctrl+K → openOverlay('command-palette')` already wired.
- `src/core/runtime/commands/types.ts` — `CommandPaletteItem` type already defined; palette command items are assembled in `src/features/palette/sources.ts`.
- `src/core/slash-commands/fuzzy.ts` — uses the `fzf` package for *name matching on slash command input*. Stays untouched; serves a different concern.

## Dependencies

- Brief 01 (fuzzy-match) has no dependencies.
- Brief 02 (aggregator) depends on Brief 01 being done first.
- Brief 03 (component) depends on Briefs 01 and 02.
- Brief 04 (keystroke) can run independently of 01–03 but must not break before 03 lands.
- Brief 05 (MRU + config) can run in parallel with 01, but 03 must consume its output.

## Done Criteria

- `Ctrl+K` opens a functional palette overlay from any screen.
- Typing filters across all 6 sources (slash commands, modes, pickers, tasks, sessions, custom actions) using subsequence fuzzy match.
- Arrow keys + Enter select; Esc dismisses.
- Recently used items rank higher within each query.
- Custom user actions defined in `.diptych/config.yaml` under `palette.customActions` appear in results.
- The old `src/components/overlays/command-palette.tsx` stub is deleted.
- `npm run test-ci` passes.

## Quality Bar

- No new npm dependencies. Fuzzy match is pure TypeScript in `src/utils/`.
- Engine files (`src/engine/palette/`) must not import React, Ink, or any `src/features/` module.
- Zero classes. Zero barrels. ESM `.js` import extensions throughout.
- Tests assert observable behavior (returned results, score ordering, rendered text) — not internal call sequences.
- Component subscribes to stores; no prop-drilling of large objects.
