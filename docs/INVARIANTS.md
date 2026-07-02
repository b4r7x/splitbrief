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
| 4 | `rg "new Error\(" src/engine/ src/lib/ src/cli/ src/core/ \| rg -v "\.test\." \| rg -v "recordException\(new Error"` | 0 matches | Errors go through `error()` factory + domain bag; raw `new Error(` is banned in engine/lib/cli/core except OTel `recordException(new Error(...))` — [ERRORS.md](./ERRORS.md) |
| 5 | `rg "^\s*set:\s*store\.set" src/stores/` | 0 matches | No raw setter on store facade — [STORES.md](./STORES.md) |
| 6 | `rg "from 'simple-git'" src/ --glob '!**/*.test.ts' \| rg -v "^src/lib/git.ts:"` | 0 matches | Production `simple-git` imports stay in `src/lib/git.ts`; tests may import it directly for real git boundary coverage — [LAYERS.md](./LAYERS.md), [TESTING.md](./TESTING.md) |
| 7 | `rg "process\.env(?:\.[A-Z_]+|\[['\"][A-Z_]+['\"]])\\s*=" src/engine/runners/agent-sdk-backend.ts` | 0 matches | Anthropic SDK key scoped via `env:` option, no global mutation — [LAYERS.md](./LAYERS.md) §SOTA provider decisions |
| 8 | `rg "\bclass\s+\w+" src/ --glob '!**/*.test.ts' --glob '!**/*.test.tsx'` | 0 matches | Zero runtime classes in production source — [ERRORS.md](./ERRORS.md), [CLAUDE.md](../CLAUDE.md) |
| 9 | `tsx scripts/import-boundaries.ts src` | 0 | Resolver-based import-boundary check (`scripts/import-boundaries.ts` `classify()`): no `src/features/<a>/** → src/features/<b>/**` cross-feature imports, no `src/components/** → src/features/**`, no FLAT-page ↔ FLAT-page imports across `src/app/screens/**` and `src/app/overlays/**` (screen↔screen, overlay↔overlay, or screen↔overlay — pages coordinate via stores), no page → app-shell import (`src/app/screens/**` \| `src/app/overlays/**` → `src/app/{root,router,provider,layout}`; `app/keys.ts` and `app/command-context.ts` are not guarded), no `src/engine/** → src/{hooks,components,cli}/**`, no upward layer-rank import (target top-dir rank > source rank), and no value `src/stores/** → src/engine/**` import (`import type` is the only sanctioned cross channel). Page isolation relies on the FLAT (depth-3) page layout — a depth-4 file under `app/screens/` escapes the `sliceRoot` page predicate; the layer-rank checks are depth-independent — [STRUCTURE.md](./STRUCTURE.md), [LAYERS.md](./LAYERS.md), [STORES.md](./STORES.md) |
| 10 | `grep -rn "callbacks\.onEvent" src/` | 0 matches | **Post-migration defensive regression guard.** Engine no longer uses the `onEvent` callback — `EventBus` + sinks are the only event path. Expected 0; any match means a regression has been reintroduced. (See [ARCHITECTURE.md §Design decisions](./ARCHITECTURE.md#design-decisions--why-eventbus)) |
| 11 | `grep -rn "OrchestratorEvent\b" src/` | 0 matches | **Post-migration defensive regression guard.** Legacy `OrchestratorEvent` type was deleted in the 2026-04-20 release; `EngineEvent` is the single source of truth. Expected 0; any match means a regression. (See [ARCHITECTURE.md §Design decisions](./ARCHITECTURE.md#design-decisions--why-eventbus)) |
| 12 | `grep -rln "from.*features" src/engine \| grep -v "\.test\." \| wc -l` | 0 | Engine MUST NOT import from features. (See [LAYERS.md](./LAYERS.md)) |
| 12b | `rg -ln "from 'react'\|from 'ink'" src/engine/ --glob '!**/*.test.ts' --glob '!**/*.test.tsx'` | 0 matches | Engine MUST NOT import React or Ink packages — [LAYERS.md](./LAYERS.md), [CLAUDE.md](../CLAUDE.md) |
| 12c | `BOUNDARY_VERBOSE=1 tsx scripts/import-boundaries.ts src 2>&1 1>/dev/null \| rg "src/engine/\*\* must not import"` | 0 matches | Engine MUST NOT import from top-level `src/hooks/`, `src/components/`, or `src/cli/`. Depth-independent resolver check (`scripts/import-boundaries.ts` `classify()`), not a fixed-depth grep — [LAYERS.md](./LAYERS.md) |
| 13 | `grep -rn "\bTuiEvent\b" src/` | 0 matches | **Post-migration defensive regression guard.** The `TuiEvent` union was removed in the 2026-04-20 release; the workflow store consumes `EngineEvent` directly. Expected 0; any match means a regression. |
| 14 | Two passes summed: (1) `rg -n -e "components/input-bar" … -e "InputBar" … -e "'slash:'" src` (no `.md` glob, so `.ts`/`.tsx` are scanned), and (2) `rg -n … CLAUDE.md docs --glob '*.md' --glob '!docs/INVARIANTS.md'` | 0 matches | React architecture refactor guard: composer, runtime commands, runners, app keys, and palette source naming are canonical. Pass 1 covers source (a single `--glob '*.md'` is a ripgrep allowlist that would exclude all `src/**`); pass 2 covers prose with its exclusion. |
| 15 | `find src -type f \( -name '*.ts' -o -name '*.tsx' \) -exec perl -ne 'while (/([\x00-\x08\x0B\x0C\x0E-\x1F\x7F])/g) { printf "%s:%d:%d:U+%04X\n", $ARGV, $., pos($_), ord($1) } close ARGV if eof' {} +` | 0 matches | No hidden ASCII control bytes in source. Use visible escapes like `\u001b` / `\u007f` in tests. |

| 16 | `rg -n "from '\.\.?/" src/ --glob '*.ts' --glob '*.tsx' --glob '!**/*.test.ts' --glob '!**/*.test.tsx' \| rg -v "\.js'\|\.json'"` | 0 matches | Relative imports in production source must use `.js` extension — ESM resolution — [CLAUDE.md](../CLAUDE.md) |
| 17 | `rg -n -P "[A-Za-z0-9_)\]]![^=)]" src/ -g '*.ts' -g '*.tsx' -g '!**/*.test.ts' -g '!**/*.test.tsx' \| rg -v "!==\|!=" \| rg -v "^src/(stores/use-stores\|engine/codebase/graph\|engine/codebase/pagerank)\.ts:"` | 0 matches | No incidental non-null (`!`) assertions in production source. Sanctioned files (`stores/use-stores`, `engine/codebase/graph`, `engine/codebase/pagerank`) are allow-listed — [CLAUDE.md](../CLAUDE.md) |
| 17b | `rg -n -P ":\s*any\b(?![ ]?[a-z])\|<any>\|\bany\[\]\|\bas any\b\|Array<any>" src/ -g '*.ts' -g '*.tsx' -g '!**/*.test.ts' -g '!**/*.test.tsx'` | 0 matches | No explicit `any` in type positions in production source (prose excluded via terminator lookahead) — [CLAUDE.md](../CLAUDE.md) |
| 17c | `rg -n -P "[)\]A-Za-z0-9_>] as [A-Z][A-Za-z0-9_]*(?=[;),<\].}>]\|$\|\[)" src/ -g '*.ts' -g '*.tsx' -g '!**/*.test.ts' -g '!**/*.test.tsx' \| rg -v "\bas const\b\|\bas unknown\b\| as Extract<" \| rg -v "^src/(stores/use-stores\|engine/hooks/substitute\|engine/hooks/dispatch\|utils/error)\.ts:"` | 0 matches | No incidental broad `as`-casts in production source (`as const` / `as unknown` / `as Extract` excluded; sanctioned files allow-listed) — [CLAUDE.md](../CLAUDE.md) |
| 18 | `npx knip --no-progress --no-config-hints --tags=-lintignore --include exports,types,files --reporter compact` | 0 matches | No dead files or unused exports/types across `src/`, `scripts/`, `evals/`, and `testing/` (fixtures negated, runtime-loaded). Knip reads `knip.json` (entry points, project glob, `ignoreDependencies`); it is not an inline ripgrep — [knip.json](../knip.json) |
| 19 | `npx depcruise --config .dependency-cruiser.cjs --output-type err-long src` | 0 errors | No runtime circular dependencies and full LAYERS.md layer-direction graph (utils→…→app/cli, one-way). Type-only cycles are erased at compile time and excluded via `viaOnly.dependencyTypesNot`. Backed by [.dependency-cruiser.cjs](../.dependency-cruiser.cjs) — [LAYERS.md](./LAYERS.md) |
| 20 | `tsx scripts/testing-helper-imports.ts \| wc -l` | 0 matches | Test files outside `testing/helpers/**` import top-level `testing/helpers/**` via the `#testing/*` alias, never relative paths. The resolver catches e2e/integration relative paths such as `../../helpers/*`; e2e-local `testing/e2e/helpers/**` and colocated helper self-tests are allowed — alias resolves through `package.json` `imports` + `tsconfig.test.json` `paths` — [TESTING.md](./TESTING.md) |
| 22 | `for path in .github/prompts .claude/commands .claude/skills .opencode/command; do [ -e "$path" ] && rg -n '\bTuiEvent\b\|src/screens/\|src/ui/' "$path" \|\| true; done` | 0 matches | Active agent instruction surfaces must not reference removed APIs or old UI paths. |
| 21 | `git ls-files -z .diptych/ .tiny-spec/ .nuke/ \| while IFS= read -r -d '' path; do [ -e "$path" ] && printf '%s\n' "$path"; done` | 0 matches | No present tracked runtime artifacts under `.diptych/`, `.tiny-spec/`, or `.nuke/` except intentional fixtures. |
| 23 | `for term in 'kanban' 'plan archive' 'cross-plan' 'swarm' 'project-management'; do rg -iq "$term" docs/VISION.md \|\| printf 'missing: %s\n' "$term"; done` | 0 matches | `VISION.md` NOT-list hosts every non-goal that satellite docs redirect to. |

Gates are consolidated here; full rationale for each lives in the linked doc.

### Workflow lifecycle and Markdown invariants

These are architectural invariants enforced by focused tests plus the layer gates above:

- Active operation state comes from normalized `runner_call_*` lifecycle events projected into `operationsStore`. `planner_status` is a legacy/fallback phase span, not the source of truth for operation-state consumers.
- Terminal operation and workflow states carry frozen `endedAt` / `durationMs`. UI components may display those values, but they must not keep their own lifecycle truth after cancel, abort, timeout, failure, or completion.
- UI cancel records local intent only for immediate feedback. The canonical audit/history event is engine-published `workflow_cancelled`, and late terminal runner/cost events after cancel remain acceptable.
- Review and conversation-document scrolling use rendered Markdown row height, not raw newline count. Markdown parsing/layout lives in `src/utils/markdown/*` and is UI-free; Ink rendering lives in `src/components/markdown.tsx` or feature-local row adapters.
- The engine must not import UI, React/Ink, stores, or Markdown components. If engine/export code needs Markdown logic, use only pure utilities from `src/utils/markdown/*`.

### Gate 9 / 12c / 19 — overlapping layer enforcement

Gates 9, 12c, and 19 enforce the same one-way layer-direction graph through two independent engines, so a regression that slips past one is caught by the other:

- **Gates 9 and 12c** run `scripts/import-boundaries.ts` (`classify()`). Its checks are: (1) `src/components/** → src/features/**`; (2) cross-feature `src/features/<a>/** → src/features/<b>/**`; (2a) **page ↔ page isolation** — no import between FLAT pages across `src/app/screens/**` and `src/app/overlays/**` (screen↔screen, overlay↔overlay, or screen↔overlay); pages compose features and coordinate via stores, never sibling pages; (2b) the **page → shell guard** — a FLAT page (`src/app/screens/**` | `src/app/overlays/**`) must not import a shell module (`src/app/{root,router,provider,layout}`); `app/keys.ts` and `app/command-context.ts` are deliberately *not* guarded, so a page may consume them; (3) `src/engine/** → src/{hooks,components,cli}/**` (gate 12c reads this class via `BOUNDARY_VERBOSE=1`); (4) the **layer-rank** rule — any relative import whose resolved target's top-dir rank `{utils:0, lib:1, core:2, engine:3, stores:3, features:4, components:4, hooks:4, app:5, cli:5}` exceeds the source's; (5) the **stores→engine** channel — a value import from `src/stores/** → src/engine/**` is a violation, but a `import type` is the single sanctioned cross-rank channel ([STORES.md](./STORES.md)) and is detected syntactically. Classes (2a)/(2b) rely on the FLAT (depth-3) page layout: `sliceRoot()` recognizes a page only as an exact `app/screens/<name>` | `app/overlays/<name>` file, so a depth-4 file under `app/screens/` would escape the page predicate and slip past both checks.
- **Gate 19** runs `dependency-cruiser` over the resolved TypeScript module graph: a `no-circular` rule (runtime cycles only) plus per-layer forbidden edges mirroring the same prohibited directions, including `stores → engine` with `dependencyTypesNot: ['type-only']` so only value imports are flagged.

The `import-boundaries` resolver is fast and regex-based (good for the inner loop); dependency-cruiser resolves the real module graph (catches cycles and resolver-blind paths). Keeping both green is the contract.

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
- [scripts/import-boundaries.ts](../scripts/import-boundaries.ts) — resolver backing gates 9 and 12c (cross-feature, components→features, engine→hooks/components/cli, layer-rank direction, stores→engine type-only channel)
- [.dependency-cruiser.cjs](../.dependency-cruiser.cjs) — dependency-cruiser config backing gate 19 (no runtime circular + LAYERS.md forbidden layer edges)
