# diptych

Open-source cost-aware task compiler for AI coding agents. An expensive planner compiles Task Briefs; a cheaper implementer executes them.

## CRITICAL — NEVER COMMIT, NEVER STAGE

Do **NOT** run `git commit`, `git add`, `git stage`, or any command that creates a commit or stages files — ever. Not even when the task is done, not even after tests pass. The user reviews and commits all changes manually. Leave every change as an unstaged modification in the working tree. This rule overrides any other instruction or workflow.

**Enforcement (best-effort):** `.claude/hooks/block-git-commits.sh` is a `PreToolUse` hook that blocks `git add` / `git stage` / `git commit` (including `git -c …`, `git -C …`, and simple quoted/backslashed variants) with exit code 2. It is a guardrail, not a sandbox — sufficiently obfuscated invocations may still slip past, so the never-commit rule above is what binds you, not the hook. A `BLOCKED:` message in stderr means the guardrail fired — stop and report to the user.

## Stack

- **Runtime:** Node.js 22+, TypeScript 6.x, ESM only (`.js` extension in imports)
- **Runner:** `tsx` (dev) / `tsc` → `dist/` (build)
- **TUI:** Ink 6.x (React 19) + `fullscreen-ink`
- **Testing:** Vitest 4.x, colocated (`foo.test.ts` next to `foo.ts`)
- **Lint/format:** Biome 2.x
- **Validation:** Zod 4.x. **Config:** `yaml`. **Git:** `simple-git`. **CLI:** `commander`. **Agent SDK:** `@anthropic-ai/claude-agent-sdk` (optional peer dep)

## Commands

```bash
npm run dev -- start "feature"   # Full workflow with TUI
npm run dev -- start --mode instant|quick|standard|speckit "..."
npm run dev -- spec|init|status|resume|migrate
npm run typecheck                # tsc --noEmit (src + test configs)
npm run lint                     # Biome check
npm run format                   # Biome format --write
npm test                         # vitest run
npm run test-ci                  # format && typecheck && lint && coverage && invariants
```

## Documentation map

Read the canonical doc **before** touching the matching area. Every link below exists.

**Start here:** New? Read [docs/MENTAL-MODEL.md](./docs/MENTAL-MODEL.md) → [docs/HOW-IT-WORKS.md](./docs/HOW-IT-WORKS.md) → [docs/WORKFLOW.md](./docs/WORKFLOW.md).

| When you're about to… | Read |
|---|---|
| Understand what diptych is | [docs/MENTAL-MODEL.md](./docs/MENTAL-MODEL.md) — the concept, no code |
| Understand how it works end-to-end | [docs/HOW-IT-WORKS.md](./docs/HOW-IT-WORKS.md) — data flow with file paths |
| Understand the workflow state machine | [docs/WORKFLOW.md](./docs/WORKFLOW.md) — phases, transitions, modes |
| Understand the orchestrator and EventBus | [docs/ENGINE.md](./docs/ENGINE.md) — orchestrator, sinks, callbacks vs events |
| Understand planner/implementer pipeline | [docs/PLANNERS-AND-IMPLEMENTERS.md](./docs/PLANNERS-AND-IMPLEMENTERS.md) — runner kinds, Task Brief, token accounting |
| Understand stores and UI | [docs/STORES-AND-UI.md](./docs/STORES-AND-UI.md) — store factory, screens, overlays |
| Understand approval gates and recovery | [docs/APPROVAL-AND-RECOVERY.md](./docs/APPROVAL-AND-RECOVERY.md) — tiered approval, escalation, drift |
| Understand supporting subsystems | [docs/SUBSYSTEMS.md](./docs/SUBSYSTEMS.md) — hooks, snapshots, IPC, repo-map, handoff, MCP |
| Add a command, event, store, or backend | [docs/EXTENDING.md](./docs/EXTENDING.md) — step-by-step recipes |
| Get diptych running for the first time | [docs/GETTING-STARTED.md](./docs/GETTING-STARTED.md) — onboarding |
| Look up a CLI command | [docs/CLI-REFERENCE.md](./docs/CLI-REFERENCE.md) — command reference |
| Look up a runtime command (`/name`) | [docs/SLASH-COMMANDS-REFERENCE.md](./docs/SLASH-COMMANDS-REFERENCE.md) — runtime commands |
| Configure diptych | [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) — config reference |
| Run end-to-end scenarios / find a recipe | [docs/USAGE-EXAMPLES.md](./docs/USAGE-EXAMPLES.md) — recipes |
| Hit a problem | [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) — symptoms & fixes |
| Add or move any file | [docs/STRUCTURE.md](./docs/STRUCTURE.md) — file tree, feature anatomy |
| Decide `utils/` vs `lib/` vs `core/` vs `engine/` vs `features/` | [docs/LAYERS.md](./docs/LAYERS.md) |
| Touch anything under `src/stores/` | [docs/STORES.md](./docs/STORES.md) |
| Add or move a type | [docs/TYPES.md](./docs/TYPES.md) |
| Create an `index.ts` | [docs/NO-BARRELS.md](./docs/NO-BARRELS.md) — zero barrels, enforced |
| Add or refactor a React hook | [docs/HOOKS.md](./docs/HOOKS.md) |
| Add a startup step | [docs/BOOTSTRAP.md](./docs/BOOTSTRAP.md) |
| Create a new error type | [docs/ERRORS.md](./docs/ERRORS.md) |
| Place a test | [docs/TESTING.md](./docs/TESTING.md) |
| Enforce a cross-cutting rule | [docs/INVARIANTS.md](./docs/INVARIANTS.md) — pre-merge grep gates |
| Orient yourself in the codebase | [docs/PRINCIPLES.md](./docs/PRINCIPLES.md) — one-page rule index |
| Judge code against the SOTA review bar | [docs/CODE-STANDARD.md](./docs/CODE-STANDARD.md) — consolidated quality standard + reviewer checklist |
| Check strategic direction | [docs/VISION.md](./docs/VISION.md), [docs/FUTURE.md](./docs/FUTURE.md) |
| Contribute to this project | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Work with API keys | [docs/API-KEYS.md](./docs/API-KEYS.md) |
| Debug a failing workflow | [docs/DEBUGGING.md](./docs/DEBUGGING.md) |
| Work with workflow hooks | [docs/HOOKS-CONFIG.md](./docs/HOOKS-CONFIG.md) |
| Enable OpenTelemetry | [docs/OTEL.md](./docs/OTEL.md) |
| Tune the planner repo-map | [docs/REPOMAP.md](./docs/REPOMAP.md) |
| Look up release history | [CHANGELOG.md](./CHANGELOG.md) |

Reference also: `.specify/memory/constitution.md` — 6 constitutional principles (v1.3.1, linked from VISION).

## Core conventions

These are the rules that apply everywhere; deeper specifications live in the linked doc.

- **Zero runtime classes.** Pure functions and module-scoped state in production source; test fixtures may contain class syntax when that is the behavior under test.
- **ESM with `.js` extension** in every import: `'./config.js'` not `'./config'`.
- **kebab-case** file and folder names (`models-dev.ts`, `lm-studio.ts`). Single-word where natural (`pricing.ts`).
- **No decorative comments.** No section banners. Ordering is the documentation.
- **Error at boundaries.** Internal functions propagate; callers decide. See [ERRORS.md](./docs/ERRORS.md).
- **No unsafe assertions.** No incidental `!` or broad `as` in production. Sanctioned exceptions: `src/utils/type-guards.ts`, `src/stores/create-store.ts`, `src/stores/use-stores.ts`, the `as AppError` factory cast in `src/utils/error.ts`, `Map.get(...)!` in `src/engine/codebase/graph.ts` and `src/engine/codebase/pagerank.ts` (Map.get after pre-population — invariant documented inline), `as unknown` for path-walking arbitrary shapes in `src/engine/hooks/substitute.ts` (recursive Record traversal) and `src/engine/hooks/dispatch.ts` (parsing untyped hook stdout JSON), and `src/lib/terminal/filtered-stdin.ts` (bridged `PassThrough` stdin that satisfies the TTY members Ink reads).
- **Zero barrels.** No re-export-only `index.ts` anywhere in `src/`. `find src -name 'index.ts'` must return nothing. See [NO-BARRELS.md](./docs/NO-BARRELS.md).
- **Zero memoization.** No `useMemo`, `useCallback`, or `React.memo`. Store selectors make them unnecessary. See [STORES.md](./docs/STORES.md).
- **No imperative handles.** No `forwardRef` / `useImperativeHandle`. Extract state to a store instead.
- **Zero engine → React imports.** `src/engine/` must not import from `ink`, `react`, or `src/features/`, `src/components/`, `src/hooks/`.
- **Zero failing gates.** `npm run test-ci` (format → typecheck → lint → test:coverage → invariants) must pass before any PR.

## Current TUI architecture

- **Composer** lives in `src/components/composer/`. Do not recreate `input-bar` modules or compatibility shims.
- **Runtime commands** live in `src/core/runtime/commands/`. They use slash names, but the registry backs composer `/` input, the command palette, and RPC dispatch.
- **App shell** lives in `src/app/`: composition root `root.tsx` (mounts `<AppProvider><Router/>`), `router.tsx` (`renderScreen` + `renderOverlay` switches → `<Layout>`), `provider.tsx` (`AppProvider`; today only `ThemeProvider`), `layout.tsx` (header + body + footer), plus app-wide keys in `keys.ts` and runtime-command context in `command-context.ts`. The shell lives entirely under `src/app/`; there is no monolithic root component or layout file at the `src/` root.
- **Screens and overlays are FLAT pages** under `src/app/screens/` (`home`, `workflow`, `summary`, `setup`) and `src/app/overlays/` (`help`, `palette`, `skills`, `sessions`, `settings`, `runners`). Each page composes its feature; feature components/hooks/helpers stay in `src/features/<x>/` and are imported via `../../features/<x>/…`. `help`, `sessions`, `setup`, and `skills` are dissolved (pure-entry) — the page is the whole surface, no `features/<x>/` folder. Pages must not import each other (they coordinate via stores) or the shell modules; see [docs/INVARIANTS.md](./docs/INVARIANTS.md) gate 9.
- **Command palette** lives in `src/features/palette/`; source assembly is `sources.ts`, ranking is `results.ts`, and the overlay entry is the page `src/app/overlays/palette.tsx`.
- **Settings** overlay entry is the page `src/app/overlays/settings.tsx`; `ModeSelector` stays at `src/features/settings/mode-selector.tsx` and is imported directly by `src/app/router.tsx` (a router-imported feature component, not a page).
- **Runner selection** is the `src/features/runners/` feature; its picker entry is the page `src/app/overlays/runners.tsx`. `ToolModelPicker` / `renderToolPicker` are component/callback names, not a `tool-picker` folder boundary.

## Runner kinds

Both planner and implementer accept five runner kinds. The `kind` field is the discriminant and is always required. Current configs write `version: 3`; `version: 2` is accepted and migrated for backwards compatibility.

| `kind` | What it is | Example |
|---|---|---|
| `cli` | Known tool subprocess | `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code` |
| `api` | OpenAI-compatible HTTP endpoint | Ollama, LM Studio, OpenRouter, DeepSeek, Groq, Together, Anthropic |
| `shell` | Arbitrary command (stdin → stdout; no shell/network sandbox) | Custom scripts |
| `agent` | Subprocess that writes files directly (no stdout extraction; no shell/network sandbox) | Custom file-writing tools |
| `agent-sdk` | Anthropic Agent SDK library call | Via `@anthropic-ai/claude-agent-sdk` |

Factory: `src/engine/runners/factory.ts` — `createPlanner(config)` / `createImplementer(config)` dispatch by `kind`.

Full config schemas and YAML examples: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Workflow modes

| Mode | Planner calls | Approval gates | Best for |
|---|:---:|:---:|---|
| `instant` | 1 | none | Trivial edits that need almost no ceremony |
| `quick` | 1 | none | Small tasks that still need a brief |
| `standard` (default) | 4 | supporting spec + briefs | Ordinary feature work |
| `speckit` | 6–7 | supporting spec + plan + briefs | Large, risky, or externally visible work |

Set via `--mode`, config `workflow.mode`, or `/mode` at runtime. `full` is only a legacy alias. Detailed semantics: [docs/WORKFLOW.md](./docs/WORKFLOW.md).

## Known limitations

- Primary development stack is TypeScript / JavaScript. Command-based validation also supports configured or detected Python, Go, and Rust pipelines.
