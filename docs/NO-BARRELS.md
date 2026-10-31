# No Barrels — Module Boundaries Principle

## Principle

**Do not create barrel files (re-export-only `index.ts` / `index.tsx`) in application code.** Import the actual module: `import { eventsStore } from '../stores/workflow/events.js'`, not `from '../stores/index.js'`.

`find src -name 'index.ts' -o -name 'index.tsx'` must print nothing. When a refactor deletes or moves a module, update all consumers in the same change. Do not add a re-export shim or a disguised barrel to smooth the migration.

**Why:**

- **Runtime cost.** The CLI runs under Node ESM with no bundler, so no tree-shaking. Importing a barrel evaluates every module it re-exports, and each store module initializes a singleton.
- **Test cost.** Vitest builds a fresh module graph per test file, so a barrel's init cost repeats in every file that imports it.
- **Startup latency.** Every module between `bin/splitbrief` and the first frame runs synchronously; barrels add modules the command does not use.
- **Tooling.** Go-to-definition and find-references follow direct imports more reliably.
- **One source of truth.** A barrel is a second list of what is public, and it drifts from the real exports.

## What counts as a barrel

A file whose **only purpose** is to re-export symbols from sibling modules (`export { foo } from './foo.js'`, `export * from './bar.js'`, `export type { Baz } from './baz.js'`). An `index.{ts,tsx}` that holds real code is not a barrel by content; rename it anyway, so the zero-index check stays simple.

### Disguised barrels — name is not the test

**Content determines barrel status, not the filename.** A file named `config-options.ts` or `catalog-adapter.ts` whose body is mostly `export { X } from './x.js'` / `export type { Y } from '../schemas/...'` **is a barrel** and is equally forbidden.

Heuristic: if deleting every `export { … } from '…'` / `export type { … } from '…'` line leaves the file at zero (or near-zero) own code, it is a disguised barrel. Delete it and rewrite consumer imports to the real producer.

## Exceptions

One exception: **the public entry point of a published library or package**. This project is an app, so the exception applies to nothing. Shared type re-exports are not an exception: they still inflate the module graph and slow tsc and tsserver.

## How to enforce

Reviewers block new barrels in code review and reference this document. `docs/INVARIANTS.md` carries the pre-merge check.

## References

- TkDodo — [Please Stop Using Barrel Files](https://tkdodo.eu/blog/please-stop-using-barrel-files)
- Vercel — [How we optimized package imports in Next.js (barrel files)](https://vercel.com/blog/how-we-optimized-package-imports-in-next-js)
- Marvin H — [The barrel file debacle (Speeding up the JavaScript ecosystem, part 7)](https://marvinh.dev/blog/speeding-up-javascript-ecosystem-part-7/)
- dev.to — [Barrel files: A case study](https://dev.to/thepassle/barrel-files-a-case-study-o5p)
- MSW — [Avoid barrel file exports (discussion)](https://github.com/mswjs/msw/discussions/2037)
