# diptych docs

> **New here?** Read in this order:
> 1. [MENTAL-MODEL.md](./MENTAL-MODEL.md) — what diptych is and how it thinks
> 2. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) — the complete data flow with file paths
> 3. [WORKFLOW.md](./WORKFLOW.md) — the state machine, phases, modes

**diptych** is a cost-aware task compiler for AI coding agents. An expensive planner compiles Task Briefs; a cheaper implementer executes them. Two roles, one job.

---

## Understanding the system

Read these to learn how diptych works. Each doc builds on the previous one.

| Doc | What it covers |
|-----|---------------|
| [MENTAL-MODEL.md](./MENTAL-MODEL.md) | The concept: two roles, Task Brief contract, four layers, modes, sessions. No code. |
| [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) | The same flow with file paths and function names. CLI entry → stores → TUI → engine → planning → tasks → review. |
| [WORKFLOW.md](./WORKFLOW.md) | The state machine: every phase, every transition, abort/continue, resume, rewind. |
| [ENGINE.md](./ENGINE.md) | The orchestrator, EventBus, sinks, callbacks vs events, abort handling, message queue. |
| [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) | Five runner kinds, planner/implementer interfaces, Task Brief structure, token accounting. |
| [STORES-AND-UI.md](./STORES-AND-UI.md) | Store factory, store groups, how events reach React, screens, overlays. |
| [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md) | Approval gates, tiered approval, escalation tiers, recovery system, drift detection. |
| [SUBSYSTEMS.md](./SUBSYSTEMS.md) | Hooks, snapshots, IPC/attach, repo-map, handoff, MCP, worktrees, slash commands. |

## Doing things

| You want to… | Go to |
|---|---|
| Get diptych running | [GETTING-STARTED.md](./GETTING-STARTED.md) |
| Add a command, event, store, or backend | [EXTENDING.md](./EXTENDING.md) |
| Look up a CLI command or flag | [CLI-REFERENCE.md](./CLI-REFERENCE.md) |
| Look up a slash command | [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) |
| Configure diptych | [CONFIGURATION.md](./CONFIGURATION.md) |
| Fix something | [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) |
| See recipes and examples | [USAGE-EXAMPLES.md](./USAGE-EXAMPLES.md) |
| Write or run tests | [TESTING.md](./TESTING.md) |

## Rules and conventions

These enforce consistency across the codebase. Read the relevant one before touching its area.

| Rule | Doc |
|------|-----|
| Zero runtime classes, ESM `.js` imports, kebab-case files | [PRINCIPLES.md](./PRINCIPLES.md) |
| Where to put files, directory length thresholds | [STRUCTURE.md](./STRUCTURE.md) |
| `utils/` vs `lib/` vs `core/` vs `engine/` vs `features/` | [LAYERS.md](./LAYERS.md) |
| Zero re-export-only `index.ts` | [NO-BARRELS.md](./NO-BARRELS.md) |
| Error taxonomy, error at boundaries | [ERRORS.md](./ERRORS.md) |
| Where to put types, Zod schema placement | [TYPES.md](./TYPES.md) |
| Store conventions, zero memoization | [STORES.md](./STORES.md) |
| React hook conventions | [HOOKS.md](./HOOKS.md) |
| Pre-merge grep gates | [INVARIANTS.md](./INVARIANTS.md) |

## Deep dives

Specialized subsystem docs linked from the main chapters above.

- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — Workflow hook schema, dispatch, substitution, trust model
- [REPOMAP.md](./REPOMAP.md) — Repo-map: PageRank, token budgeting, SQLite cache
- [OTEL.md](./OTEL.md) — OpenTelemetry spans from EngineEvents
- [TASK-CONTRACT.md](./TASK-CONTRACT.md) — Task Brief schema, quality gate, evidence
- [BOOTSTRAP.md](./BOOTSTRAP.md) — Startup steps and ordering
- [API-KEYS.md](./API-KEYS.md) — Provider keys and secret hygiene
- [DEBUGGING.md](./DEBUGGING.md) — Diagnosing failures, log locations
- [WORKTREES.md](./WORKTREES.md) — Git worktree isolation for parallel sessions

## Direction and history

- [VISION.md](./VISION.md) — Product north star
- [DIRECTION.md](./DIRECTION.md) — UX principles, engineering decisions
- [FUTURE.md](./FUTURE.md) — Open questions, longer-horizon backlog
- [FEATURES.md](./FEATURES.md) — Feature catalog
- [CHANGELOG.md](./CHANGELOG.md) — Release notes

## Project-level

- [`../README.md`](../README.md) — Install and quick start
- [`../CLAUDE.md`](../CLAUDE.md) — Agent instructions
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — Development setup
