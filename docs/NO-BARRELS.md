# No Barrels — Module Boundaries Principle

> **Status**: Adopted for `src/stores/` (2026-04-17). Scheduled for incremental rollout to `src/engine/`, `src/core/`, `src/components/`.

## Principle

**Do not create barrel files (re-export-only `index.ts` / `index.tsx`) in application code.** Prefer direct imports of the actual module.

```ts
// ✅ Good — direct import, named and traceable
import { workflowStore } from '../stores/workflow/workflow.js';
import { loadConfig } from '../core/config/loading.js';

// ❌ Bad — goes through a barrel
import { workflowStore } from '../stores/index.js';
import { loadConfig } from '../core/config/index.js';
```

This is a codebase-wide principle. `src/stores/` is where it was first applied; the rest follows.

## Why

### 1. Runtime cost without a bundler

This project ships a CLI that runs under Node ESM (`tsx` in dev, `tsc` + Node in production). **No bundler**, therefore **no tree-shaking**. Every `export { x } from './x.js'` line in a barrel causes Node to evaluate `./x.js` the moment the barrel is imported — even if the caller only needs a single unrelated symbol.

For 16 store modules (each initializing a module-scoped singleton), importing from a top-level barrel forces 16 store initializations per consumer, every time.

### 2. Test-run amplification

Vitest isolates modules per test file — each test gets a fresh module graph. A barrel in the dependency path of a test file multiplies that barrel's init cost by the number of tests that import it.

Rough math for stores before this principle was adopted: 144 test files × ~16 store inits per barrel = thousands of avoidable module initializations per full `npm test` run.

### 3. Startup latency

CLI UX is sensitive to time-to-first-output. Every module on the path between `bin/diptych` and the first rendered frame runs synchronously. Barrels inflate that path with modules the current command doesn't use.

Next.js internal case study (Vercel 2024): removing barrel files dropped module count from ~11,000 to ~3,500 (**−68%**), cutting startup by 5–10 seconds in dev.

### 4. Tooling compatibility

- **Tree-shakers in downstream bundlers** (if this project ever publishes a library) frequently give up on `export * from` and pull in the whole transitive tree. Granular imports keep the door open.
- **Go-to-definition** and "find all references" in editors traverses barrels less reliably than direct imports.

### 5. Refactoring surface

A barrel becomes a second source of truth for "what's public". Drift between barrel re-exports and actual module exports is a common source of subtle bugs (renamed symbol still re-exported, removed symbol still referenced, new symbol forgotten in barrel).

## What counts as a barrel

A file whose **only purpose** is to re-export symbols from sibling modules.

```ts
// This IS a barrel — delete it.
export { foo } from './foo.js';
export * from './bar.js';
export type { Baz } from './baz.js';
```

A file that **contains real code** and happens to be named `index.ts` is NOT a barrel. Example: `src/components/input-bar/index.tsx` is the component implementation — that stays. The "index = folder module" convention for single-component folders is fine.

### Disguised barrels — name is not the test

**Content determines barrel status, not the filename.** A file named `config-options.ts`, `catalog-adapter.ts`, or `picker-model-catalog.ts` whose body is mostly `export { X } from './x.js'` / `export type { Y } from '../schemas/...'` **is a barrel** and is equally forbidden. The `index.ts` name is just the most common giveaway — a disguised barrel by content inflates the module graph identically.

Heuristic: if deleting every `export { … } from '…'` / `export type { … } from '…'` line leaves the file at zero (or near-zero) own code, it is a disguised barrel. Fix by deleting it and rewriting consumer imports to the real producer. Canonical cases removed in Batch 1A / 1C: `core/types/config-options.ts` re-export block, `features/tool-picker/picker-model-catalog.ts`, `features/tool-picker/catalog-adapter.ts` — see inventory below and [ADR 0006](./adr/0006-types-colocation-with-schemas.md).

## Exceptions

The principle allows one exception: **public API surfaces of published libraries or package boundaries**. This project is an app, not a library — so right now the exception applies to **nothing**. If we later publish a package, the top-level entry point of that package can be a barrel (that's what @tanstack/react-query does, and it's the right call for consumer ergonomics).

Shared type re-exports are not an exception. If `src/types/index.ts` re-exports from 10 sibling type files, those type-only re-exports still inflate the build graph and still slow down tsc/tsserver; inline imports are preferred.

## Current inventory (updated 2026-04-17 after restructure)

**All application barrels have been removed.** `find src -name 'index.ts'` returns zero results. The three `index.tsx` files left are component implementations (not barrels).

### Previously removed (historical record)

| Path | Removed by | Notes |
|---|---|---|
| `src/stores/**/index.ts` (all) | Stores restructure (2026-04, Phases 1–3) | Stores folder was first to be unbarreled. |
| `src/types.ts` | RFC-02 | Top-level type re-export barrel. |
| `src/core/config/index.ts` | FW-1 | Consumers import directly from `loading.ts`, `validation.ts`, etc. |
| `src/core/providers/index.ts` | FW-1 | Catalog + enum modules imported directly. |
| `src/core/slash-commands/index.ts` | FW-1 | Imported directly from command modules. |
| `src/engine/index.ts` | FW-2 | Top-level engine barrel. |
| `src/engine/detection/index.ts` | FW-2 | Imported directly from `detect.ts`, `cache.ts`, etc. |
| `src/engine/orchestrator/index.ts` | FW-2 | Imported directly from orchestrator submodules. |
| `src/engine/orchestrator/planning/index.ts` | FW-2 | Renamed to `planning/run.ts` — contained real dispatch code, not just re-exports. |
| `src/engine/skills/index.ts` | FW-2 | Imported directly from `discovery.ts`. |
| `src/components/summary/index.ts` | Features restructure | Summary components moved to `src/features/summary/components/`. |
| `src/core/types/config-options.ts` (re-export block) | Batch 1A (2026-04) | ~12 `export type { X } from '../schemas/...'` lines re-exporting `PlannerConfig`, `ImplementerConfig`, workflow/planner config variants, and enum values. A disguised barrel by content — the filename was not `index.ts` but the re-exports made `config-options.ts` a second public surface. Consumers now import directly from `core/schemas/*`. |
| `src/core/schemas/config.ts` tail (lines 43-46) | Batch 1A (2026-04) | `export type { PlannerConfig } from './planner-config.js'`, same for `ImplementerConfig`, plus `export { PlannerConfigSchema, ImplementerConfigSchema }`. Consumers now import from `planner-config.ts` / `implementer-config.ts` directly. |
| `src/stores/discovery/model-cache.ts` line 5 | Batch 1A (2026-04) | `export type { DetectedModel } from '../../core/types/config-options.js'` — one-liner type re-export. Consumers now import `DetectedModel` from `core/types/config-options.ts` directly. |
| `src/features/tool-picker/picker-model-catalog.ts` + `catalog-adapter.ts` | Batch 1C (2026-04) | **Disguised barrels**: even if a file isn't named `index.ts`, if its content is mostly re-exports (like `picker-model-catalog.ts`, which re-exported the contents of `model-sorting.ts` + `picker-options.ts` plus one own function, and `catalog-adapter.ts`, a 12-line wrapper injecting the `modelCacheStore`), it IS a barrel and must be eliminated. Dissolved into the deep module `src/features/tool-picker/model-catalog.ts`. |

### Not barrels (keep as-is)

| Path | Role |
|---|---|
| `src/components/input-bar/index.tsx` | Component file. Folder has many related helpers; `index.tsx` IS the component. |
| `src/components/overlays/sessions-picker/index.tsx` | Component file, same pattern. |
| `src/components/overlays/settings-overlay/index.tsx` | Component file, same pattern. |

Rule: if the `index.{ts,tsx}` is the primary implementation and other files in the folder are its helpers, it's not a barrel.

## Rollout plan

- **Phase 2 of stores restructure** — applies this principle to `src/stores/` (no `index.ts` anywhere in the subtree).
- **Future RFC A** — `src/core/{config,providers,slash-commands}/index.ts` removal. Relatively contained; single-domain.
- **Future RFC B** — `src/engine/**/index.ts` removal. Larger surface, many consumers. Best done after stores to validate the direct-import pattern holds at scale.
- **Future RFC C** — `src/components/summary/index.ts` removal. Tiny; bundle into RFC A.

Each future RFC follows the same gate protocol: typecheck, lint, full test suite, zero grep hits on deleted barrel paths.

## How to enforce

After rollout completes, add a lint rule (Biome custom or `no-restricted-imports`) forbidding imports that match `'**/index.js'` where the target file is a pure re-exporter. Details deferred to the future RFC that does the last barrel removal.

Until enforcement lands, reviewers should block new barrel creations during code review and reference this document.

## References

- TkDodo — [Please Stop Using Barrel Files](https://tkdodo.eu/blog/please-stop-using-barrel-files)
- Vercel — [How we optimized package imports in Next.js (barrel files)](https://vercel.com/blog/how-we-optimized-package-imports-in-next-js)
- Marvin H — [The barrel file debacle (Speeding up the JavaScript ecosystem, part 7)](https://marvinh.dev/blog/speeding-up-javascript-ecosystem-part-7/)
- dev.to — [Barrel files: A case study](https://dev.to/thepassle/barrel-files-a-case-study-o5p)
- MSW — [Avoid barrel file exports (discussion)](https://github.com/mswjs/msw/discussions/2037)
