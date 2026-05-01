# diptych docs

> **If you are a new AI agent reading this codebase:** follow this reading order before touching anything.
> 1. [GETTING-STARTED.md](./GETTING-STARTED.md) — what diptych does and how to run it
> 2. [COST-AWARE-IMPLEMENTER-DIRECTION.md](./COST-AWARE-IMPLEMENTER-DIRECTION.md) — product boundary for planner -> cheap implementer work
> 3. [COST-AWARE-IMPLEMENTER-HANDOFF.md](./COST-AWARE-IMPLEMENTER-HANDOFF.md) — implemented cost-aware pool + Plan Review v2 handoff
> 4. [CONCEPTS.md](./CONCEPTS.md) — shared vocabulary (Task Brief, Phase, Runner, EventBus, Sink)
> 5. [ARCHITECTURE.md](./ARCHITECTURE.md) — design rationale (Part 1) and current inventory (Part 2)
> 6. [FEATURES.md](./FEATURES.md) — full feature inventory (Phase 6 shipped features included)
> 7. [USAGE-EXAMPLES.md](./USAGE-EXAMPLES.md) — cookbook recipes and end-to-end scenarios

**diptych** is an open-source, cost-aware task compiler for AI coding agents. An expensive **planner** compiles a Task Brief — a self-contained, evidence-grounded specification — and a cheaper **implementer** executes it. Two halves, one job: spend tokens where they pay, save them where they don't.

This page is the entry point to the `docs/` folder. Pick the row that matches what you're trying to do.

## Quick paths

| You want to… | Go to |
|---|---|
| Get diptych running for the first time | [GETTING-STARTED.md](./GETTING-STARTED.md) — install, init, run your first task |
| See what diptych can do | [FEATURES.md](./FEATURES.md) — full feature catalog |
| Look up how to do X | [USAGE-EXAMPLES.md](./USAGE-EXAMPLES.md) — recipes and how-tos |
| Look up a CLI command | [CLI-REFERENCE.md](./CLI-REFERENCE.md) — every command and flag |
| Configure diptych | [CONFIGURATION.md](./CONFIGURATION.md) — full config reference with examples |
| Understand cost-aware implementer profiles and Plan Review v2 | [COST-AWARE-IMPLEMENTER-DIRECTION.md](./COST-AWARE-IMPLEMENTER-DIRECTION.md) + [COST-AWARE-IMPLEMENTER-HANDOFF.md](./COST-AWARE-IMPLEMENTER-HANDOFF.md) — product boundary and implemented map |
| Look up a slash command in the TUI | [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — runtime commands and keybindings |
| Fix something that broke | [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — symptoms and fixes |

## Concepts

Read these once to learn the vocabulary; they explain the **why** behind the system.

- **[VISION.md](./VISION.md)** — the cost-aware planner/implementer thesis and product north star.
- **[DIRECTION.md](./DIRECTION.md)** — UX principles, testing architecture, engineering decisions, competitive advantages.
- **[CONCEPTS.md](./CONCEPTS.md)** — shared vocabulary: Task Brief, EngineEvent, EventBus, Phase, Hook, RepoMap, Sink, Runner.
- **[PRINCIPLES.md](./PRINCIPLES.md)** — one-page rule index: zero classes, zero barrels, ESM-only, error at boundaries.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — system design and current inventory: planner/implementer contracts, orchestrator loop, event model, design rationale (Part 1), plus verified file/event/command counts and public API surface (Part 2).

## Core Workflow References

Deep dives for the main planner -> implementer loop. Start here before reaching for advanced surfaces.

- **[WORKFLOW.md](./WORKFLOW.md)** — workflow modes (`instant`, `quick`, `standard`, `speckit`); gates and interaction model.
- **[MIGRATION.md](./MIGRATION.md)** — config migration guide: upgrading from earlier versions.
- **[HOOKS-CONFIG.md](./HOOKS-CONFIG.md)** — user-declared workflow hooks: schema, dispatch, substitution.
- **[HOOKS.md](./HOOKS.md)** — React hook conventions: where they live, what they may import.
- **[TASK-CONTRACT.md](./TASK-CONTRACT.md)** — Task Brief schema: fields, evidence, validation contract.
- **[INVARIANTS.md](./INVARIANTS.md)** — pre-merge grep gates that enforce cross-cutting rules.
- **[ERRORS.md](./ERRORS.md)** — error taxonomy and the "error at boundaries" rule.
- **[TYPES.md](./TYPES.md)** — where to put types and how to share them across layers.
- **[NO-BARRELS.md](./NO-BARRELS.md)** — zero re-export-only `index.ts`; rationale and enforcement.
- **[STORES.md](./STORES.md)** — store conventions under `src/stores/`: selectors, no memoization.
- **[BOOTSTRAP.md](./BOOTSTRAP.md)** — startup steps and how to add new ones.
- **[REPOMAP.md](./REPOMAP.md)** — the planner repo-map: how it is built, tuned, and consumed.
- **[OTEL.md](./OTEL.md)** — OpenTelemetry integration: what is emitted and where.
- **[API-KEYS.md](./API-KEYS.md)** — provider API key handling, environment variables, secret hygiene.
- **[DEBUGGING.md](./DEBUGGING.md)** — diagnosing failing workflows, log locations, common failure modes.
- **[TESTING.md](./TESTING.md)** — where tests live (colocated), how to run them, what `test-ci` enforces.
- **[STRUCTURE.md](./STRUCTURE.md)** — file tree, feature anatomy, directory length thresholds.
- **[LAYERS.md](./LAYERS.md)** — how to choose between `utils/`, `lib/`, `core/`, `engine/`, `features/`.

## Advanced Surfaces

Use these after the core workflow is clear. They are safety, interop, or runtime-management surfaces; they are not a plan archive, kanban system, or generic multi-agent manager.

- **[WORKTREES.md](./WORKTREES.md)** — advanced isolation for parallel sessions in separate git worktrees.
- **[FEATURES.md](./FEATURES.md#advanced-handoff-and-interop)** — handoff packs and the read-only MCP resources server.
- **[FEATURES.md](./FEATURES.md#advanced-server-client-architecture)** — detached server/client sessions and attach/replay behavior.
- **[FEATURES.md](./FEATURES.md#safety-and-control)** — snapshots and hash-guarded restore.
- **[FUTURE.md](./FUTURE.md)** — open questions and longer-horizon backlog beyond the current phase.

## Legacy

These docs were superseded by newer references. They remain for historical context; new readers should use the replacements listed.

- **[CONFIG.md](./CONFIG.md)** — old field-by-field config doc. Superseded by **[CONFIGURATION.md](./CONFIGURATION.md)**.
- **[SLASH-COMMANDS.md](./SLASH-COMMANDS.md)** — old slash command doc. Superseded by **[SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md)**.

## History

- **[CHANGELOG.md](./CHANGELOG.md)** — canonical release notes and migration guides (root `CHANGELOG.md`). `docs/CHANGELOG.md` is a supplementary narrative log.

## Specs (work-in-progress + completed)

Per-deliverable specs — README, decisions, and agent briefs — live under [`superpowers/specs/`](./superpowers/specs/). Each subdirectory is a single tracked piece of work; open its `README.md` for the entry point.

## Project-level

See [`../README.md`](../README.md) for install + quick start, [`../CLAUDE.md`](../CLAUDE.md) for Claude Code-specific instructions, and [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for development setup.
