# Contributing to diptych

Thanks for considering a contribution. diptych is a small, opinionated codebase — reading before writing saves time for everyone.

## Before you start

Read in order:

1. [docs/PRINCIPLES.md](./docs/PRINCIPLES.md) — architectural rules at a glance.
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
npm run test-ci               # format -> typecheck -> lint -> test:coverage -> invariants
```

**Before submitting a PR, `npm run test-ci` MUST pass.**

## Adding a feature

1. Find where the code goes — [docs/STRUCTURE.md §File placement decision tree](./docs/STRUCTURE.md#file-placement-decision-tree).
2. Respect layer direction — [docs/LAYERS.md](./docs/LAYERS.md). Imports flow one way: `utils -> lib -> core -> engine/stores -> features`. No cross-feature imports.
3. Write tests for observable behavior — [docs/TESTING.md](./docs/TESTING.md). Colocate unit tests next to source; multi-folder flows go under `testing/integration/{cli,orchestrator,ui}/`.
4. Validate at boundaries only — [docs/ERRORS.md](./docs/ERRORS.md).
5. Run `npm run test-ci`.

## Pre-merge gates

Enforced on every PR; the full list and rationale lives in [docs/INVARIANTS.md](./docs/INVARIANTS.md). Run locally:

```bash
npm run check:invariants
```

Do not duplicate the gate list in new docs; update [docs/INVARIANTS.md](./docs/INVARIANTS.md) and `scripts/check-invariants.ts` together.

## Code conventions

- **Zero runtime classes.** Production source uses pure functions and module-scoped state. Tests may contain class syntax only when class behavior is under test.
- **ESM with `.js` extension** in imports: `import x from './foo.js'`, never `./foo`.
- **kebab-case** for file and folder names.
- **No barrels.** No re-export-only `index.ts` anywhere in `src/` or `testing/` — see [docs/NO-BARRELS.md](./docs/NO-BARRELS.md).
- **No memoization.** No `useMemo`, `useCallback`, `React.memo`, `forwardRef`, `useImperativeHandle` — see [docs/STORES.md](./docs/STORES.md).
- **No decorative comments.** No section banners. Ordering documents, not banners.
- **No unsafe assertions.** No incidental `!` or broad `as` in production. Sanctioned exceptions listed in [CLAUDE.md](./CLAUDE.md).
- **Engine has zero React imports.** `src/engine/` must not import `ink`, `react`, or anything under `src/features/`, `src/components/`, `src/hooks/`.
- **Use options objects for wide APIs.** Any function with 4+ parameters, or any exported/cross-boundary function with 3+ parameters, switches to a named options object; a bare `boolean` param or two adjacent same-typed params are banned regardless of count. Tiny local non-exported math/helper primitives are exempt. Canonical: [docs/CODE-STANDARD.md §4](./docs/CODE-STANDARD.md#4-parameter-design).

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

Version lives in [`package.json`](./package.json); notable changes are recorded in [CHANGELOG.md](./CHANGELOG.md). The `prepack` script triggers `npm run build`, so `npm pack`/`npm publish` rebuild `dist/` automatically. Maintainers handle the tag + publish.

## Getting help

- [docs/DEBUGGING.md](./docs/DEBUGGING.md) for common issues and diagnostic flags.
- When opening an issue, include the session id and, if possible, `.diptych/sessions/<id>/session.jsonl`.
