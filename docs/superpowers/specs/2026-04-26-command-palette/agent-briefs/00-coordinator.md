# 00 — Coordinator

> Use this only when coordinating the full command-palette spec across multiple agents.
> If assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, or `git commit`.

## Execution Order

```text
01 Fuzzy Matcher          (no dependencies — can start immediately)
  └─ 02 Result Aggregator (depends on 01)
       └─ 03 Palette Component  (depends on 01 and 02)
            └─ 04 Keystroke Binding  (confirm-only; depends on 03 being ready to mount)

05 MRU + Custom Actions   (can run in parallel with 01; 03 must consume its output)
```

Recommended serial order if running one agent at a time:

1. `01-fuzzy-matcher.md`
2. `05-mru-and-custom-actions.md`
3. `02-result-aggregator.md`
4. `03-palette-component.md`
5. `04-keystroke-binding.md`

If running agents in parallel: 01 and 05 can run together; 02 starts after 01 finishes; 03 starts after 01, 02, and 05 finish; 04 starts after 03 finishes.

## Shared Files To Read Before Any Brief

- `CLAUDE.md`
- `src/stores/navigation/router.ts` — `OverlayType`, `InputMode`, `Screen`
- `src/stores/ui/overlay.ts` — `overlayStore.open`, `overlayStore.close`
- `src/hooks/use-app-keys.ts` — existing `Ctrl+K` binding at line 82
- `src/core/slash-commands/types.ts` — `CommandPaletteItem`, `CommandContext`
- `src/core/slash-commands/catalog.ts` — full command list
- `src/core/slash-commands/dispatch.ts` — `toPaletteItems`, `executeSlashCommand`
- `src/core/slash-commands/context.ts` — `buildCommandContext`
- `src/components/overlays/command-palette.tsx` — existing stub (to be deleted by Brief 03)
- `src/core/schemas/config.ts` — `ConfigSchema` (to be extended by Brief 05)

## Shared Invariants

- Do not stage or commit.
- No new npm dependencies.
- No classes anywhere in `src/`.
- No barrel files (`index.ts` re-export-only).
- ESM `.js` import suffixes in every import statement.
- Engine code in `src/engine/palette/` must not import React, Ink, `src/features/`, or `src/components/`.
- Zero `useMemo`, `useCallback`, `React.memo`, `forwardRef`.
- Tests are colocated (`foo.test.ts` beside `foo.ts`).
- Tests assert observable behavior — not internal helper calls.

## Verification After Each Brief

```bash
npm run typecheck
npm run lint
npm test
```

For final handoff after all briefs:

```bash
npm run test-ci
```

## Cross-Brief Shared Types

The `PaletteResult` type (defined by Brief 02, consumed by Brief 03) is the central data contract:

```ts
export type PaletteSource = 'slash' | 'mode' | 'picker' | 'task' | 'session' | 'custom';

export type PaletteResult = {
  id: string;           // stable unique id for MRU tracking
  label: string;
  description: string;
  source: PaletteSource;
  shortcut: string | null;
  score: number;        // 0..1, higher = better match
  mruRank: number;      // 0 = not in MRU; lower positive = more recent
  action: () => void;
};
```

Brief 05 (MRU) exports `paletteMruStore` which Brief 03 reads.
Brief 02 (Aggregator) accepts a `mruIds: string[]` parameter — it does not import the MRU store directly (engine cannot import stores).
