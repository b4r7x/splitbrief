# Contributing to diptych

Thanks for considering a contribution. diptych is a small, opinionated codebase — reading before writing saves time for everyone.

## Before you start

Read in order:

1. [docs/PRINCIPLES.md](./docs/PRINCIPLES.md) — 20 architectural rules at a glance.
2. [docs/CONCEPTS.md](./docs/CONCEPTS.md) — shared vocabulary (EventBus, EngineEvent, Phase, Hook, RepoMap).
3. [docs/STRUCTURE.md](./docs/STRUCTURE.md) — where files live, file-placement decision tree.
4. [docs/TESTING.md](./docs/TESTING.md) — test philosophy and placement.

[CLAUDE.md](./CLAUDE.md) is the one-page editorial index that links every other doc.

## Development setup

Requires **Node.js 22+**. The project is TypeScript 6.x, ESM only.

```bash
git clone <repo>
cd tiny-spec
npm ci
npm run dev -- start "your feature"   # verify local runs
```

## Workflow commands

All real targets come from [`package.json`](./package.json):

```bash
npm run dev -- <cmd>          # run CLI from sources via tsx
npm run build                 # tsc -> dist/
npm run typecheck             # src + test configs (tsc --noEmit)
npm run lint                  # Biome check
npm run format                # Biome format --write
npm test                      # vitest run
npm run test:watch            # vitest watch mode
npm run test:coverage         # vitest run --coverage
npm run test-ci               # typecheck -> lint -> test (the full gate)
```

**Before submitting a PR, `npm run test-ci` MUST pass.**

## Adding a feature

1. Find where the code goes — [docs/STRUCTURE.md §File placement decision tree](./docs/STRUCTURE.md#file-placement-decision-tree).
2. Respect layer direction — [docs/LAYERS.md](./docs/LAYERS.md). Imports flow one way: `utils -> lib -> core -> engine/stores -> features`. No cross-feature imports.
3. Write tests for observable behavior — [docs/TESTING.md](./docs/TESTING.md). Colocate unit tests next to source; multi-folder flows go under `testing/integration/{cli,orchestrator,ui}/`.
4. Validate at boundaries only — [docs/ERRORS.md](./docs/ERRORS.md).
5. Run the pre-merge gates below.

## Pre-merge gates

Enforced on every PR; full list + rationale lives in [docs/INVARIANTS.md](./docs/INVARIANTS.md). Run locally:

```bash
# 1. No barrels
find src -name 'index.ts'

# 2. Inferred types live with their schema
rg "z\.infer" src/core/types/

# 3. Zero memoization / imperative handles
rg "useMemo|useCallback|React\.memo|forwardRef|useImperativeHandle" src/

# 4. No raw throw new Error in engine/lib/cli (use error() factory)
rg "throw new Error" src/engine/ src/lib/ src/cli/ | rg -v "\.test\."

# 5. No raw setter on store facade
rg "^\s*set:\s*store\.set" src/stores/

# 6. simple-git imported only in lib/git in production source
rg "from 'simple-git'" src/ --glob '!**/*.test.ts' | rg -v "^src/lib/git.ts:"

# 7. Anthropic SDK key scoped via env option, no global mutation
rg "process\.env\['ANTHROPIC_API_KEY'\]" src/engine/agent-sdk-backend.ts

# 8. No classes in production source
rg "\bclass\s+\w+" src/ --glob '!**/*.test.ts' --glob '!**/*.test.tsx'

# 9. No cross-feature imports
rg "from '\.\./\.\./features/" src/features/

# 10. onEvent callback is gone (EventBus-only)
grep -rn "callbacks\.onEvent" src/

# 11. Legacy OrchestratorEvent is gone
grep -rn "OrchestratorEvent\b" src/

# 12. Engine MUST NOT import from features
grep -rln "from.*features" src/engine | grep -v "\.test\." | wc -l

# 13. Legacy TuiEvent is gone
grep -rn "\bTuiEvent\b" src/
```

Each gate must return 0 matches (or the stated count). Sanctioned exceptions for unsafe assertions are enumerated in [CLAUDE.md §Core conventions](./CLAUDE.md#core-conventions).

## Code conventions

- **Zero runtime classes.** Production source uses pure functions and module-scoped state. Tests may contain class syntax only when class behavior is under test.
- **ESM with `.js` extension** in imports: `import x from './foo.js'`, never `./foo`.
- **kebab-case** for file and folder names.
- **No barrels.** No re-export-only `index.ts` anywhere in `src/` or `testing/` — see [docs/NO-BARRELS.md](./docs/NO-BARRELS.md).
- **No memoization.** No `useMemo`, `useCallback`, `React.memo`, `forwardRef`, `useImperativeHandle` — see [docs/STORES.md](./docs/STORES.md).
- **No decorative comments.** No section banners. Ordering documents, not banners.
- **No unsafe assertions.** No incidental `!` or broad `as` in production. Sanctioned exceptions listed in [CLAUDE.md](./CLAUDE.md).
- **Engine has zero React imports.** `src/engine/` must not import `ink`, `react`, or anything under `src/features/`, `src/components/`, `src/hooks/`.

Full rule index: [docs/PRINCIPLES.md](./docs/PRINCIPLES.md).

## Testing

- Colocate unit tests: `foo.test.ts` next to `foo.ts`.
- Multi-folder flows live in `testing/integration/{cli,orchestrator,ui}/`.
- Assert on observable state (store contents, files on disk, emitted events) — never on call counts.
- No `vi.mock('./sibling.js')`, no `vi.spyOn` on internal modules.
- Extend the existing `createFakePlanner` / `createFakeImplementer` in `testing/helpers/orchestrator-factories.ts` — do not add new fakes.
- Sanctioned `vi.mock` targets, forbidden patterns, and the manual smoke checklist live in [docs/TESTING.md](./docs/TESTING.md).

## Commits

**Do not commit AI-generated code without reviewing it.**

This repo ships `.claude/hooks/block-git-commits.sh` — a `PreToolUse` hook that blocks `git add`, `git stage`, and `git commit` (including `git -c ...` and chained variants) when invoked from Claude Code or another agent. A `BLOCKED:` line on stderr means the guardrail fired. Humans stage and commit manually after reviewing the diff.

No commit-message format is enforced. Keep the first line concise; reference issues with `#N` when applicable.

## Adding a runner kind

Planner and implementer both dispatch on a required `kind` discriminant across five variants: `cli`, `api`, `shell`, `agent`, `agent-sdk`. The factory lives at `src/engine/runners/factory.ts` — `createPlanner(config)` / `createImplementer(config)`. New integrations plug in here.

Full config schemas and YAML examples: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Adding a hook

User-extensible workflow hooks fire shell commands or JS modules at workflow events (`pre_task`, `post_commit`, etc.). See [docs/HOOKS-CONFIG.md §Writing your first hook](./docs/HOOKS-CONFIG.md#writing-your-first-hook) for the template, variable substitution, failure modes, and the trust-prompt security model.

Built-in hook source lives under `src/engine/hooks/builtins/`. Adding a new built-in requires updating the registry (`src/engine/hooks/builtins/registry.ts`) and a colocated test.

## Release process

Version lives in [`package.json`](./package.json); notable changes are recorded in [CHANGELOG.md](./CHANGELOG.md). `npm run prepublishOnly` triggers `npm run build`. Maintainers handle the tag + publish.

## Getting help

- [docs/DEBUGGING.md](./docs/DEBUGGING.md) for common issues and diagnostic flags.
- When opening an issue, include the session id and, if possible, `.diptych/sessions/<id>/session.jsonl`.
