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

| # | Command | Expected | Rule / ADR |
|---|---|---|---|
| 1 | `find src -name 'index.ts'` | 0 results | No barrels — [NO-BARRELS.md](./NO-BARRELS.md) |
| 2 | `rg "z\.infer" src/core/types/` | 0 matches | Inferred types live with their schema — [TYPES.md](./TYPES.md), [ADR 0006](./adr/0006-types-colocation-with-schemas.md) |
| 3 | `rg "useMemo\|useCallback\|React\.memo\|forwardRef\|useImperativeHandle" src/` | 0 matches | Zero memoization, no imperative handles — [STORES.md](./STORES.md), [CLAUDE.md](../CLAUDE.md) |
| 4 | `rg "throw new Error" src/engine/ src/lib/ src/cli/ \| rg -v "\.test\."` | 0 matches | Errors go through `error()` factory + domain bag — [ERRORS.md](./ERRORS.md) |
| 5 | `rg "^\s*set:\s*store\.set" src/stores/` | 0 matches | No raw setter on store facade — [STORES.md](./STORES.md), [ADR 0010](./adr/0010-store-setter-hardening.md) |
| 6 | `rg "from 'simple-git'" src/ \| rg -v "lib/git"` | 0 matches | `simple-git` imported only in `lib/git.ts` — [LAYERS.md](./LAYERS.md), [ADR 0008](./adr/0008-engine-git-boundary.md) |
| 7 | `rg "process\.env\['ANTHROPIC_API_KEY'\]" src/engine/agent-sdk.ts` | 0 matches | Anthropic SDK key scoped via `env:` option, no global mutation — [ADR 0012](./adr/0012-anthropic-sdk-and-openai-signal.md) |
| 8 | `rg "class\s+\w+\s+extends\s+Error" src/` | 0 matches | Zero classes — errors via factory bags — [ERRORS.md](./ERRORS.md) |
| 9 | `rg "from '\.\./\.\./features/" src/features/` | 0 matches | No cross-feature imports — [STRUCTURE.md](./STRUCTURE.md), [ADR 0007](./adr/0007-feature-boundary-enforcement.md) |

Gates 1, 2, 5, 6, 7 have historical precedent in the ADR "Verification" sections — this doc collects them in one place so nothing slips.

---

## SOTA provider decisions (reference)

When touching provider SDK code, match these patterns rather than reinventing — see [ADR 0012](./adr/0012-anthropic-sdk-and-openai-signal.md):

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
