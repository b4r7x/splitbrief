# Invariants — Pre-Merge Grep Gates

A consolidated set of grep / find commands that must return **zero** (or match the stated count) before any PR merges. Each one encodes an architectural rule documented elsewhere in `docs/`; this file is the single place to run them all.

All gates run automatically as part of `npm run test-ci` via `npm run check:invariants` (implemented in `scripts/check-invariants.ts`).
The runner fails closed: a broken gate command is a failed gate, not a zero-count pass.

---

## The gates

| # | Command | Expected | Rule |
|---|---|---|---|
| 1 | `find src -name 'index.ts'` | 0 results | No barrels — [NO-BARRELS.md](./NO-BARRELS.md) |
| 1b | `find src -name 'index.tsx'` | 0 results | No barrels (JSX variant) — [NO-BARRELS.md](./NO-BARRELS.md) |
| 2 | `rg "z\.infer" src/core/types/` | 0 matches | Inferred types live with their schema — [TYPES.md](./TYPES.md) |
| 3 | `rg "useMemo\|useCallback\|React\.memo\|forwardRef\|useImperativeHandle" src/` | 0 matches | Zero memoization, no imperative handles — [STORES.md](./STORES.md), [CLAUDE.md](../CLAUDE.md) |
| 4 | `rg "throw new Error" src/engine/ src/lib/ src/cli/ \| rg -v "\.test\."` | 0 matches | Errors go through `error()` factory + domain bag — [ERRORS.md](./ERRORS.md) |
| 5 | `rg "^\s*set:\s*store\.set" src/stores/` | 0 matches | No raw setter on store facade — [STORES.md](./STORES.md) |
| 6 | `rg "from 'simple-git'" src/ --glob '!**/*.test.ts' \| rg -v "^src/lib/git.ts:"` | 0 matches | Production `simple-git` imports stay in `src/lib/git.ts`; tests may import it directly for real git boundary coverage — [LAYERS.md](./LAYERS.md), [TESTING.md](./TESTING.md) |
| 7 | `rg "process\.env(?:\.[A-Z_]+|\[['\"][A-Z_]+['\"]])\\s*=" src/engine/agent-sdk-backend.ts` | 0 matches | Anthropic SDK key scoped via `env:` option, no global mutation — [LAYERS.md](./LAYERS.md) §SOTA provider decisions |
| 8 | `rg "\bclass\s+\w+" src/ --glob '!**/*.test.ts' --glob '!**/*.test.tsx'` | 0 matches | Zero runtime classes in production source — errors via factory bags — [ERRORS.md](./ERRORS.md) |
| 9 | `rg "from '\.\./\.\./features/" src/features/` | 0 matches | No cross-feature imports — [STRUCTURE.md](./STRUCTURE.md) |
| 10 | `grep -rn "callbacks\.onEvent" src/` | 0 matches | **Post-migration defensive regression guard.** Engine no longer uses the `onEvent` callback — `EventBus` + sinks are the only event path. Expected 0; any match means a regression has been reintroduced. (See [ARCHITECTURE.md §Design decisions](./ARCHITECTURE.md#design-decisions--why-eventbus)) |
| 11 | `grep -rn "OrchestratorEvent\b" src/` | 0 matches | **Post-migration defensive regression guard.** Legacy `OrchestratorEvent` type was deleted during the 2026-04 uplift; `EngineEvent` is the single source of truth. Expected 0; any match means a regression. (See [ARCHITECTURE.md §Design decisions](./ARCHITECTURE.md#design-decisions--why-eventbus)) |
| 12 | `grep -rln "from.*features" src/engine \| grep -v "\.test\." \| wc -l` | 0 | Engine MUST NOT import from features. (See [LAYERS.md](./LAYERS.md)) |
| 12b | `rg -ln "from 'react'\|from 'ink'" src/engine/ --glob '!**/*.test.ts' --glob '!**/*.test.tsx'` | 0 matches | Engine MUST NOT import React or Ink packages — [LAYERS.md](./LAYERS.md), [CLAUDE.md](../CLAUDE.md) |
| 12c | `rg -n "from '\.\.\/\.\.\/\.\.\/(hooks\|components\|cli)/" src/engine/ --glob '!**/*.test.ts' --glob '!**/*.test.tsx'` | 0 matches | Engine MUST NOT import from top-level `src/hooks/`, `src/components/`, or `src/cli/` — [LAYERS.md](./LAYERS.md) |
| 13 | `grep -rn "\bTuiEvent\b" src/` | 0 matches | **Post-migration defensive regression guard.** The `TuiEvent` union was removed during the 2026-04 uplift; the workflow store consumes `EngineEvent` directly. Expected 0; any match means a regression. |
| 14 | `rg -n -e "components/input-bar" -e "core/slash-commands" -e "features/tool-picker" -e "hooks/use-app-keys" -e "workflow/components/command-palette-overlay" -e "engine/palette-aggregate" -e "InputBar" -e "toPaletteItems" -e "slashItems" -e "source: 'slash'" -e "'slash:'" src CLAUDE.md docs --glob '*.md' --glob '!docs/INVARIANTS.md' --glob '!docs/superpowers/**' --glob '!docs/audits/**'` | 0 matches | React architecture refactor guard: composer, runtime commands, runners, app keys, and palette source naming are canonical. |
| 15 | `find src -type f \( -name '*.ts' -o -name '*.tsx' \) -exec perl -ne 'while (/([\x00-\x08\x0B\x0C\x0E-\x1F\x7F])/g) { printf "%s:%d:%d:U+%04X\n", $ARGV, $., pos($_), ord($1) } close ARGV if eof' {} +` | 0 matches | No hidden ASCII control bytes in source. Use visible escapes like `\u001b` / `\u007f` in tests. |

| 16 | `rg -n "from '\.\.?/" src/ --glob '*.ts' --glob '*.tsx' --glob '!**/*.test.ts' --glob '!**/*.test.tsx' \| rg -v "\.js'\|\.json'"` | 0 matches | Relative imports in production source must use `.js` extension — ESM resolution — [CLAUDE.md](../CLAUDE.md) |

Gates are consolidated here; full rationale for each lives in the linked doc.

---

## SOTA provider decisions (reference)

When touching provider SDK code, match these patterns rather than reinventing:

- **Anthropic Agent SDK key scoping.** Pass `options.env = { ...process.env, ANTHROPIC_API_KEY: apiKey }` to `query()`. Never mutate `process.env` globally. The per-call `env` option is required for the supported `@anthropic-ai/claude-agent-sdk` peer range.
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
