# Contributing to SPLITBRIEF

Thanks for considering a contribution. SPLITBRIEF is a small, opinionated codebase — reading before writing saves time for everyone.

## Before you start

Read in order:

1. [docs/PRINCIPLES.md](./docs/PRINCIPLES.md) — architectural rules at a glance.
2. [docs/CONCEPTS.md](./docs/CONCEPTS.md) — shared vocabulary (EventBus, EngineEvent, Phase, Hook, RepoMap).
3. [docs/STRUCTURE.md](./docs/STRUCTURE.md) — where files live, file-placement decision tree.
4. [docs/TESTING.md](./docs/TESTING.md) — test philosophy and placement.

[CLAUDE.md](./CLAUDE.md) is the one-page editorial index that links every other doc.

## Development setup

Requires **Node.js 22+** and **ripgrep** (`rg`) for the invariant checks and their tests. On Linux, CLI integration and replay tests also require `bubblewrap` and `socat`. The project is TypeScript 6.x, ESM only.

```bash
git clone <repo>
cd splitbrief
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
npm test                      # vitest run --project unit
npm run test:integration      # git, worktree, run-loop and process tests
npm run test:watch            # vitest watch mode
npm run test:coverage         # tsx scripts/coverage-run.ts (vitest --coverage + run pruning)
npm run release-check         # format:check -> typecheck -> lint -> test -> test:integration -> e2e -> invariants -> skills:check (no coverage)
npm run test:e2e:live         # OPT-IN, costs money: real CLI calls (needs SPLITBRIEF_REAL_CLI_E2E=1)
npm run test:e2e:release      # OPT-IN release proof: full live matrix (needs SPLITBRIEF_RELEASE_LIVE=1; real CLI calls)
npm run test-ci               # format -> typecheck -> lint -> test:coverage -> e2e -> invariants -> skills:check
```

**Before submitting a PR, `npm run release-check` MUST pass** — it is the fast gate every PR is held to. `npm run test-ci` is the exhaustive form that additionally enforces the coverage thresholds. The coverage workflow runs only when you start it by hand.

## Adding a feature

1. Find where the code goes — [docs/STRUCTURE.md §File placement decision tree](./docs/STRUCTURE.md#file-placement-decision-tree).
2. Respect layer direction — [docs/LAYERS.md](./docs/LAYERS.md). Imports flow one way: `utils -> lib -> core -> engine/stores -> features`. No cross-feature imports.
3. Write tests for observable behavior — [docs/TESTING.md](./docs/TESTING.md). Colocate unit tests next to source; multi-folder flows go under `testing/integration/{cli,orchestrator,ui}/`.
4. Validate at boundaries only — [docs/ERRORS.md](./docs/ERRORS.md).
5. Run `npm run release-check` (or `npm run test-ci` for the exhaustive form).

## Pre-merge gates

Enforced on every PR; the full list and rationale lives in [docs/INVARIANTS.md](./docs/INVARIANTS.md). Run locally:

```bash
npm run check:invariants
```

Do not duplicate the gate list in new docs; update [docs/INVARIANTS.md](./docs/INVARIANTS.md) and `scripts/invariants/gates.ts` together.

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
- Colocate integration tests as `foo.integration.test.ts` or `foo.integration.test.tsx`. See [the membership rule](./docs/TESTING.md#unit-and-integration-tests).
- Multi-folder flows live in `testing/integration/{cli,orchestrator,ui}/`.
- Assert on observable state (store contents, files on disk, emitted events) — never on call counts.
- No `vi.mock('./sibling.js')`, no `vi.spyOn` on internal modules.
- Extend `fauxPlanner` / `fauxImplementer` in `testing/helpers/faux/` — do not add new fakes. Legacy `makePlanner` / `makeImplementer` in `testing/helpers/orchestrator-factories.ts` remain for older suites only.
- Sanctioned `vi.mock` targets, forbidden patterns, and the manual smoke checklist live in [docs/TESTING.md](./docs/TESTING.md).

## Commits

**Do not commit AI-generated code without reviewing it.**

This repo ships `.claude/hooks/block-git-commits.sh` — a `PreToolUse` hook that blocks `git add`, `git stage`, and `git commit` (including `git -c ...` and chained variants) when invoked from Claude Code or another agent. A `BLOCKED:` line on stderr means the guardrail fired. Humans stage and commit manually after reviewing the diff.

No commit-message format is enforced. Keep the first line concise; reference issues with `#N` when applicable.

## Adding a runner kind

Planner and implementer both dispatch on a required `kind` discriminant across four variants: `cli`, `api`, `shell`, `agent`. The factory lives at `src/engine/runners/factory.ts` — `createPlanner(config)` / `createImplementer(config)`. New integrations plug in here.

Full config schemas and YAML examples: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Adding a hook

User-extensible workflow hooks fire shell commands at workflow events (`pre_task`, `post_commit`, etc.). Every hook is a `command` declared in the config's `hooks` section. See [docs/HOOKS-CONFIG.md §Writing your first hook](./docs/HOOKS-CONFIG.md#writing-your-first-hook) for the template, variable substitution, failure modes, and the trust-prompt security model.

## User-facing text

Text a user can read must not show how SPLITBRIEF is built. This covers the shipped docs (the Markdown files in `package.json` `files`), `CHANGELOG.md` and the GitHub release notes, CLI and TUI strings, the website, and the skills a user installs (the skills in `.claude-plugin/marketplace.json` and every skill not marked `metadata.internal: true`).

Never write these there:

- **Admissions.** Do not say that something is untested, unverified, not verified live, not captured live or not checked on a platform, and do not list such tools or "known gaps". State what is supported. Say "not supported" only where the user needs it to act.
- **Internal process.** No "owner" or "owner decision", no agent or model names used to build the project (Sol, Astra, Opus, codex lanes), no workflows, lanes, smoke runs, review verdicts or handoffs, no dates of internal passes, no `.nuke/` paths, and no finding, task, issue or lane ids (`N-7`, `DOC-2`, `REL-04`, `S11`, `T-080`, `#67`).
- **Implementation detail in the changelog.** No function names, file paths, gate numbers, internal types or state-machine events. Write what the user gets or what changed for the user, grouped as Added, Changed, Fixed and Removed.
- **Unfinished or apologetic words.** No "for now", "hack", "TODO", "temporary", "we hope" or "should work".

Contributor docs (`docs/RELEASING.md`, `TESTING.md`, `DOGFOODING.md`, `INVARIANTS.md`, `CODE-STANDARD.md` and the other docs outside `package.json` `files`) may use process language. A contributor skill carries `metadata.internal: true`, so skills.sh hides it, and the marketplace does not list it. The live-matrix manifest is a private release record: it never goes into the changelog or a GitHub release ([RELEASING.md](./docs/RELEASING.md#the-release-rule)). Invariant gate 59 (`scripts/user-facing-text.ts`) checks the clear markers.

## Maintaining the agent skills

[docs/SKILLS.md](./docs/SKILLS.md) describes the skills for their users. This section is for the maintainers. A contributor skill (`splitbrief-babysit` and the dev skills under `.claude/skills/`) carries `metadata.internal: true` and is not listed in `.claude-plugin/marketplace.json`.

### Contract sources

Each skill step follows the engine contract in this table.

| Skill step | Engine contract or path |
|---|---|
| One planning session, defaults and typed plan | `src/core/schemas/plan.ts`; `src/engine/orchestrator/planning/session.ts` and `plan-session.ts` |
| Plan admission and Markdown renderings | `src/engine/spec/plan-checks.ts`, `plan-tasks.ts`, `prompts/task-format-example.ts` |
| One behaviour with its tests and callers | TaskSpec intent/criteria; `src/core/pipeline-spec/brief.ts` |
| Ordinary files as guidance; protected confirmation | `src/core/pipeline-spec/scope.ts` |
| One local retry and planner consult | `src/core/pipeline-spec/retries.ts`; `src/core/schemas/consult.ts`; `src/engine/orchestrator/consult/` |
| Stale refresh and persistent lineage bounds | `src/engine/orchestrator/task/stale-inputs.ts`; `src/core/pipeline-spec/bounds.ts` |
| Proposed decisions and confirmed Plan context | ImplementerReport decisions and `plan.decisions` |
| End/task cadence and completed-task coverage | `workflow.review` (`src/core/schemas/config.ts`) |
| Typed review, derived pass and appended fixes | `src/core/schemas/review.ts`, `src/core/review/verdict.ts`; review answer with fix work |
| Reviewer checks, base re-run and stop rule | `src/engine/orchestrator/review-checks.ts`; `src/engine/orchestrator/validation/changed-script.ts`; `src/core/schemas/review.ts` |
| Test check command, narrowing and capture | `src/core/pipeline-spec/gates.ts`; `src/core/validation/stage-command.ts` and `stacks/` |
| Registered checks at each cadence | Plan and TaskSpec checks; `src/engine/orchestrator/task/brief-gate.ts`, `src/engine/orchestrator/run/pre-review-checks.ts` |
| Spawn recipes, halts and deadlines | `src/engine/runners/cli-tools/`; `src/core/pipeline-spec/halts.ts`, `timeouts.ts` |
| Plain CLI output | `src/engine/events/sinks/stdout-text.ts` |

### Reference library and ownership

The canonical `skills/splitbrief/references/run-protocol.md` holds the generated wait protocol, including the inline fallback.
Sync copies that reference and the explicitly listed scripts into each skill that runs a tool.

Author shared references only in `skills/splitbrief/references/`. The library contains exactly these nine files.
Each entry file explicitly lists its dependencies; sync copies those files into that skill's own `references/` directory.
The entry files compose shared procedures and add only their entry-specific input or write boundary.

| Reference | Owns |
|---|---|
| `family-map.md` | Entry selection, arguments, and engine command mapping. |
| `planning.md` | Planning session, typed plan, input conversion, and decisions ledger. |
| `brief-format.md` | Markdown brief contract and BRIEF_HOME_OF_FIELD placement. |
| `run-protocol.md` | Dispatch, waiting, saved progress, continuation, and review cadence. |
| `recovery.md` | Retry, consult, bounds, and review fix work; generated consult-table and fix-cycle. |
| `gates.md` | Validation resolution, baselines, registered checks, and change evidence. |
| `implementer-prompt.md` | Prompt construction and advisory completion report. |
| `review-format.md` | Review packet, typed answer, exact coverage, and derived pass. |
| `tool-recipes.md` | Tool probes, invocation recipes, terminal records, and seat diagnoses. |

The script library stays at `skills/splitbrief-run/scripts/`.
Sync copies explicitly named scripts with their executable bits.
A copied skill folder contains every reference and script it names, including references required by its local library.
`scripts/sync-skills.test.ts` verifies each pipeline skill copied alone.

### Generated blocks

Generated blocks read engine contracts and constants. Handwritten skill steps follow the contract sources above.
Never render a retired rule merely because its constant still exists.
`npm run skills:sync` updates blocks and mirrors. `npm run skills:check` verifies them.

Use `<!-- generated: <id> -->` and `<!-- /generated -->` in Markdown.
Use `# generated: <id>` and `# /generated` in shell scripts.
`scripts/skill-blocks.ts` owns renderers; GENERATED_BLOCK_IDS names the active blocks.

| Source | Blocks |
|---|---|
| TaskSpec field map and workspace/report contracts | brief-template, implementer-preamble, body-order, closing-line |
| ConsultAnswerSchema, retries and BOUNDS | consult-table, consult-contract |
| BOUNDS seat retries and reset waiting | seat-recovery |
| Pipeline validation and stack registry | gate-rules, gates, brief-grouping, suggested-files, baseline-rule |
| The review contract and REVIEW_CYCLE_CAP | review-packet, verdict-rules, fix-cycle |
| Engine halts and deadlines | halt-signatures, halt-signatures-sh, timeouts, wait-protocol |
| CLI adapters | recipe:<tool> |

`consult-table` renders only into canonical `recovery.md`; `wait-protocol` renders only into `run-protocol.md`.
The consult table derives its actions from ConsultAnswerSchema and its bounds from BOUNDS.
`seat-recovery` renders the transient retry count and reset-wait bound into `tool-recipes.md` from BOUNDS.

Change either side, run `npm run skills:sync`, and the skills follow; `npm run skills:check` (part of `release-check`) fails when a generated block, a mirror, or a frontmatter rule is out of date.

`skills/splitbrief/references/` is the only place the hand-written parts of a shared reference are edited, and `skills/splitbrief-run/scripts/` is the only place a script is edited. `skills:sync` mirrors the subset each optional skill mentions into its own `references/`, and copies each `scripts/<name>` a `SKILL.md` mentions byte-identically into that skill's own `scripts/`; a stale, missing, or no-longer-mentioned mirror fails `skills:check`. Source and mirrors are both committed — skills.sh reads the repo as is. The SPLITBRIEF CLI itself never injects the four pipeline skills or `splitbrief-babysit` into any seat's prompt (they describe the loop it is already running, and the babysit skill supervises the CLI itself); the contract reaches the planner from the pipeline spec instead. The repo's dev skills are unaffected.

## Release process

Version lives in [`package.json`](./package.json); notable changes are recorded in [CHANGELOG.md](./CHANGELOG.md). The `prepare` script triggers `npm run build`, so `npm pack`/`npm publish` rebuild `dist/` automatically. It is npm's only pre-pack hook that also installs devDependencies for a git install, so `npm install <git-url>` builds `dist/` too — as does a plain `npm install`/`npm ci` in a clone. The maintainer tags and publishes with the procedure in [docs/RELEASING.md § npm release](./docs/RELEASING.md#npm-release).

## Getting help

- [docs/DEBUGGING.md](./docs/DEBUGGING.md) for common issues and diagnostic flags.
- When opening an issue, include the session id and, if possible, `.splitbrief/sessions/<id>/session.jsonl`.
