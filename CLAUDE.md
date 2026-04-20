# diptych

Open-source CLI that orchestrates expensive AI (Claude Code / Opus) for planning and cheap/local AI (Ollama / LM Studio) for implementation — saves 50%+ on AI coding costs.

## CRITICAL — NEVER COMMIT, NEVER STAGE

Do **NOT** run `git commit`, `git add`, `git stage`, or any command that creates a commit or stages files — ever. Not even when the task is done, not even after tests pass. The user reviews and commits all changes manually. Leave every change as an unstaged modification in the working tree. This rule overrides any other instruction or workflow.

**Enforcement:** `.claude/hooks/block-git-commits.sh` is a `PreToolUse` hook that blocks `git add` / `git stage` / `git commit` (including `git -c …` and chained variants) with exit code 2. A `BLOCKED:` message in stderr means the guardrail fired — stop and report to the user.

## Stack

- **Runtime:** Node.js 22+, TypeScript 6.x, ESM only (`.js` extension in imports)
- **Runner:** `tsx` (dev) / `tsc` → `dist/` (build)
- **TUI:** Ink 6.x (React 19) + `fullscreen-ink`, Shiki 4.x (WASM) for highlighting
- **Testing:** Vitest 4.x, colocated (`foo.test.ts` next to `foo.ts`)
- **Lint/format:** Biome 2.x
- **Validation:** Zod 4.x. **Config:** `yaml`. **Git:** `simple-git`. **CLI:** `commander`. **Agent SDK:** `@anthropic-ai/claude-agent-sdk` (optional peer dep)

## Commands

```bash
npm run dev -- start "feature"   # Full workflow with TUI
npm run dev -- start --mode quick|standard|full "..."
npm run dev -- spec|init|status|resume|migrate
npm run typecheck                # tsc --noEmit (src + test configs)
npm run lint                     # Biome check
npm run format                   # Biome format --write
npm test                         # vitest run
npm run test-ci                  # typecheck && lint && test
```

## Documentation map

Read the canonical doc **before** touching the matching area. Every link below exists.

**Start here:** New? Read [docs/PRINCIPLES.md](./docs/PRINCIPLES.md) → [docs/CONCEPTS.md](./docs/CONCEPTS.md) → [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

| When you're about to… | Read |
|---|---|
| Start reading the docs | [docs/README.md](./docs/README.md) — index + reading order |
| Orient yourself in the codebase | [docs/PRINCIPLES.md](./docs/PRINCIPLES.md) — one-page rule index |
| Understand the system end-to-end | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — planner/implementer contracts, orchestrator loop, event model |
| Look up shared vocabulary | [docs/CONCEPTS.md](./docs/CONCEPTS.md) |
| Add or move any file | [docs/STRUCTURE.md](./docs/STRUCTURE.md) — file tree, feature anatomy, length thresholds |
| Decide `utils/` vs `lib/` vs `core/` vs `engine/` vs `features/` | [docs/LAYERS.md](./docs/LAYERS.md) |
| Touch anything under `src/stores/` | [docs/STORES.md](./docs/STORES.md) |
| Add or move a type | [docs/TYPES.md](./docs/TYPES.md) |
| Create an `index.ts` | [docs/NO-BARRELS.md](./docs/NO-BARRELS.md) — zero barrels, enforced |
| Add or refactor a React hook | [docs/HOOKS.md](./docs/HOOKS.md) |
| Add a startup step | [docs/BOOTSTRAP.md](./docs/BOOTSTRAP.md) |
| Create a new error type | [docs/ERRORS.md](./docs/ERRORS.md) |
| Place a test | [docs/TESTING.md](./docs/TESTING.md) |
| Enforce a cross-cutting rule | [docs/INVARIANTS.md](./docs/INVARIANTS.md) — pre-merge grep gates |
| Understand end-user modes | [docs/WORKFLOW.md](./docs/WORKFLOW.md) |
| Use a slash command at runtime | [docs/SLASH-COMMANDS.md](./docs/SLASH-COMMANDS.md) |
| Check strategic direction | [docs/VISION.md](./docs/VISION.md), [docs/FUTURE.md](./docs/FUTURE.md) |
| Contribute to this project | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Work with API keys | [docs/API-KEYS.md](./docs/API-KEYS.md) |
| Look up any config field | [docs/CONFIG.md](./docs/CONFIG.md) |
| Debug a failing workflow | [docs/DEBUGGING.md](./docs/DEBUGGING.md) |
| Work with workflow hooks (user-declared commands) | [docs/HOOKS-CONFIG.md](./docs/HOOKS-CONFIG.md) |
| Enable OpenTelemetry | [docs/OTEL.md](./docs/OTEL.md) |
| Tune the planner repo-map | [docs/REPOMAP.md](./docs/REPOMAP.md) |
| Review architectural rationale | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) §Design decisions, [docs/HOOKS-CONFIG.md](./docs/HOOKS-CONFIG.md) §Design decisions, [docs/REPOMAP.md](./docs/REPOMAP.md) §Design decisions, [docs/OTEL.md](./docs/OTEL.md) §Design decisions |
| Look up release history & amendments | [CHANGELOG.md](./CHANGELOG.md), [docs/CHANGELOG.md](./docs/CHANGELOG.md) |

Reference also: `.specify/memory/constitution.md` — 6 constitutional principles (v1.3.1, linked from VISION).

## Core conventions

These are the rules that apply everywhere; deeper specifications live in the linked doc.

- **Zero classes.** Pure functions, module-scoped state. The `class` keyword does not appear in `src/`.
- **ESM with `.js` extension** in every import: `'./config.js'` not `'./config'`.
- **kebab-case** file and folder names (`models-dev.ts`, `lm-studio.ts`). Single-word where natural (`pricing.ts`).
- **No decorative comments.** No section banners. Ordering is the documentation.
- **Error at boundaries.** Internal functions propagate; callers decide. See [ERRORS.md](./docs/ERRORS.md).
- **No unsafe assertions.** No incidental `!` or broad `as` in production. Sanctioned exceptions: `src/utils/type-guards.ts`, `src/stores/create-store.ts`, `src/stores/use-stores.ts`, branded ID constructors in `src/core/types/state-actions.ts` and `src/core/schemas/task.ts`, `Map.get(...)!` in `src/engine/codebase/graph.ts` and `src/engine/codebase/pagerank.ts` (Map.get after pre-population — invariant documented inline), `as unknown` for path-walking arbitrary shapes in `src/engine/hooks/substitute.ts` (recursive Record traversal) and `src/engine/hooks/dispatch.ts` (parsing untyped hook stdout JSON).
- **Zero barrels.** No re-export-only `index.ts` anywhere in `src/`. `find src -name 'index.ts'` must return nothing. See [NO-BARRELS.md](./docs/NO-BARRELS.md).
- **Zero memoization.** No `useMemo`, `useCallback`, or `React.memo`. Store selectors make them unnecessary. See [STORES.md](./docs/STORES.md).
- **No imperative handles.** No `forwardRef` / `useImperativeHandle`. Extract state to a store instead.
- **Zero engine → React imports.** `src/engine/` must not import from `ink`, `react`, or `src/features/`, `src/components/`, `src/hooks/`.
- **Zero failing tests.** `npm run test-ci` (typecheck → lint → test) must pass before any PR.

## Runner kinds

Both planner and implementer accept five runner kinds. The `kind` field is the discriminant and is always required. Config uses `version: 2`.

| `kind` | What it is | Example |
|---|---|---|
| `cli` | Known tool subprocess | `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code` |
| `api` | OpenAI-compatible HTTP endpoint | Ollama, LM Studio, OpenRouter, DeepSeek, Groq, Together, Anthropic |
| `shell` | Arbitrary command (stdin → stdout) | Custom scripts |
| `agent` | Subprocess that writes files directly (no stdout extraction) | Custom file-writing tools |
| `agent-sdk` | Anthropic Agent SDK library call | Via `@anthropic-ai/claude-agent-sdk` |

Factory: `src/engine/runners/factory.ts` — `createPlanner(config)` / `createImplementer(config)` dispatch by `kind`.

Full config schemas and YAML examples: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Workflow modes

| Mode | Planner calls | Approval gates | Best for |
|---|:---:|:---:|---|
| `quick` | 1 | 0 | Small: "add endpoint", "fix bug" |
| `standard` (default) | 4 | 1 (spec) | Medium features |
| `full` | 4 | 2 (spec + plan) | Large features, team handoffs |

Set via `--mode`, config `workflow.mode`, or `/mode` at runtime. Full semantics: [docs/WORKFLOW.md](./docs/WORKFLOW.md).

## Known limitations

- TypeScript / JavaScript target projects only.
