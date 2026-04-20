# sample-project fixture

Minimum viable TypeScript project for repo-map integration tests.

Used by `src/engine/codebase/repomap.test.ts` and `parse.test.ts` to exercise the full pipeline end-to-end: tree-sitter parse → import graph → PageRank ranking → token-budgeted format.

## Graph shape

```
a.ts ──→ b.ts
 │
 └───→ c.ts ──→ d.ts
```

- `a.ts` — entry point, imports `b1` from `b.ts` and `c1` from `c.ts`.
- `b.ts` — exports `b1`, plus `b2` (orphan, never imported — exercises unreferenced-symbol handling).
- `c.ts` — imports `d1` from `d.ts`, exports `c1`.
- `d.ts` — leaf, exports `d1`.

## Why 4 files

Smaller than this loses multi-hop coverage (`a → c → d`). Larger slows the test without adding graph shapes. The set covers: import resolution, multi-hop dependency, orphan symbol, and PageRank ordering (central files outrank leaves).

## Do not edit casually

Changing these files changes the expected PageRank ordering and symbol output in the tests. If you edit, update the assertions in `repomap.test.ts` to match.
