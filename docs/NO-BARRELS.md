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

## Exceptions

The principle allows one exception: **public API surfaces of published libraries or package boundaries**. This project is an app, not a library — so right now the exception applies to **nothing**. If we later publish a package, the top-level entry point of that package can be a barrel (that's what @tanstack/react-query does, and it's the right call for consumer ergonomics).

Shared type re-exports are not an exception. If `src/types/index.ts` re-exports from 10 sibling type files, those type-only re-exports still inflate the build graph and still slow down tsc/tsserver; inline imports are preferred.

## Current inventory (2026-04-17)

Audit of `src/` produced 12 files matching `index.{ts,tsx}`. Discriminated by role:

### Barrels to remove (future RFCs)

| Path | Re-exports from |
|---|---|
| `src/core/config/index.ts` | `access.ts`, `build-runner.ts`, `loading.ts`, `migration.ts`, `overrides.ts`, `runner-config.ts`, `transforms.ts`, `validation.ts` |
| `src/core/providers/index.ts` | multiple provider modules |
| `src/core/slash-commands/index.ts` | multiple command modules |
| `src/engine/detection/index.ts` | `detect.ts` + siblings |
| `src/engine/index.ts` | top-level engine barrel |
| `src/engine/orchestrator/index.ts` | orchestrator submodules |
| `src/engine/orchestrator/planning/index.ts` | planning submodules |
| `src/engine/skills/index.ts` | discovery + siblings |
| `src/components/summary/index.ts` | summary sub-components |

Each requires a dedicated mini-RFC or can be bundled into one "unbarreling" RFC. Agent strategy mirrors Phase 2 of the stores restructure: grep consumers, direct-import rewrite, delete the barrel, run gates.

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
