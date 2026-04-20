# Invariants — Pre-Merge Grep Gates

A consolidated set of grep / find commands that must return **zero** (or match the stated count) before any PR merges. Each one encodes an architectural rule documented elsewhere in `docs/`; this file is the single place to run them all.

Run before every commit of non-trivial scope:

```bash
npm run typecheck
npm run lint
npm test
```

…plus the checks below.

---

## The gates

| # | Command | Expected | Rule |
|---|---|---|---|
| 1 | `find src -name 'index.ts'` | 0 results | No barrels — [NO-BARRELS.md](./NO-BARRELS.md) |
| 2 | `rg "z\.infer" src/core/types/` | 0 matches | Inferred types live with their schema — [TYPES.md](./TYPES.md) |
| 3 | `rg "useMemo\|useCallback\|React\.memo\|forwardRef\|useImperativeHandle" src/` | 0 matches | Zero memoization, no imperative handles — [STORES.md](./STORES.md), [CLAUDE.md](../CLAUDE.md) |
| 4 | `rg "throw new Error" src/engine/ src/lib/ src/cli/ \| rg -v "\.test\."` | 0 matches | Errors go through `error()` factory + domain bag — [ERRORS.md](./ERRORS.md) |
| 5 | `rg "^\s*set:\s*store\.set" src/stores/` | 0 matches | No raw setter on store facade — [STORES.md](./STORES.md) |
| 6 | `rg "from 'simple-git'" src/ \| rg -v "lib/git"` | 0 matches | `simple-git` imported only in `lib/git.ts` — [LAYERS.md](./LAYERS.md) |
| 7 | `rg "process\.env\['ANTHROPIC_API_KEY'\]" src/engine/agent-sdk.ts` | 0 matches | Anthropic SDK key scoped via `env:` option, no global mutation — [LAYERS.md](./LAYERS.md) §SOTA provider decisions |
| 8 | `rg "class\s+\w+\s+extends\s+Error" src/` | 0 matches | Zero classes — errors via factory bags — [ERRORS.md](./ERRORS.md) |
| 9 | `rg "from '\.\./\.\./features/" src/features/` | 0 matches | No cross-feature imports — [STRUCTURE.md](./STRUCTURE.md) |
| 10 | `grep -rn "callbacks\.onEvent" src/` | 0 matches | **Post-migration defensive regression guard.** Engine no longer uses the `onEvent` callback — `EventBus` + sinks are the only event path. Expected 0; any match means a regression has been reintroduced. (See [ARCHITECTURE.md §Design decisions](./ARCHITECTURE.md#design-decisions--why-eventbus)) |
| 11 | `grep -rn "OrchestratorEvent\b" src/` | 0 matches | **Post-migration defensive regression guard.** Legacy `OrchestratorEvent` type was deleted during the 2026-04 uplift; `EngineEvent` is the single source of truth. Expected 0; any match means a regression. (See [ARCHITECTURE.md §Design decisions](./ARCHITECTURE.md#design-decisions--why-eventbus)) |
| 12 | `grep -rln "from.*features" src/engine \| grep -v "\.test\." \| wc -l` | 0 | Engine MUST NOT import from features. (See [LAYERS.md](./LAYERS.md)) |
| 13 | `grep -rn "\bTuiEvent\b" src/` | 0 matches | **Post-migration defensive regression guard.** The `TuiEvent` union was removed during the 2026-04 uplift; the workflow store consumes `EngineEvent` directly. Expected 0; any match means a regression. |

Gates are consolidated here; full rationale for each lives in the linked doc.

---

## SOTA provider decisions (reference)

When touching provider SDK code, match these patterns rather than reinventing:

- **Anthropic Agent SDK key scoping.** Pass `options.env = { ...process.env, ANTHROPIC_API_KEY: apiKey }` to `query()`. Never mutate `process.env` globally. The per-call `env` option was confirmed in SDK `0.2.114`.
- **OpenAI abort signal.** Pass `signal` as the second arg to every resource call: `client.chat.completions.create(body, { signal })`. The in-loop `opts.signal?.aborted` check stays for aborts landing between chunks, but the wire-through makes the initial POST cancellable too.

---

## Disguised-barrel check (heuristic)

Not a single grep — a review heuristic. When adding or modifying a file under `src/`, verify:

- Does the file's body consist mostly of `export { … } from '…'` / `export type { … } from '…'` lines?
- If you delete those lines, is the file left with zero or near-zero own code?

If yes to both, the file is a disguised barrel regardless of its name. Delete it and rewrite consumer imports to the real producer. See [NO-BARRELS.md §Disguised barrels](./NO-BARRELS.md#disguised-barrels--name-is-not-the-test).

---

## References

- [PRINCIPLES.md](./PRINCIPLES.md) — one-page rule index
- [NO-BARRELS.md](./NO-BARRELS.md) — no re-export-only files anywhere in `src/`
- [TYPES.md](./TYPES.md) — type placement, `z.infer` colocation
- [LAYERS.md](./LAYERS.md) — layer boundaries, `simple-git` single-source rule
- [STORES.md](./STORES.md) — store facade shape, `__testReset` escape hatch
- [ERRORS.md](./ERRORS.md) — factory + bag pattern, no raw `throw new Error`
- [STRUCTURE.md](./STRUCTURE.md) — cross-feature import rule
- [TESTING.md](./TESTING.md) — test philosophy and forbidden patterns
