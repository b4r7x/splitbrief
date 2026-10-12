# SPLITBRIEF docs

> **New here?** Read in this order:
> 1. [MENTAL-MODEL.md](./MENTAL-MODEL.md) — what SPLITBRIEF is and how it thinks
> 2. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) — the complete data flow with file paths
> 3. [WORKFLOW.md](./WORKFLOW.md) — the state machine, phases, the planning session

**SPLITBRIEF** orchestrates two coding tools. One plans and reviews, the other executes, and SPLITBRIEF holds the contract, the isolation, the validation, the retries, the escalation, and the evidence between them. What a run spent is reported after it finishes; it is not the promise.

---

## Understanding the system

Read these to learn how SPLITBRIEF works. Each doc builds on the previous one.

| Doc | What it covers |
|-----|---------------|
| [MENTAL-MODEL.md](./MENTAL-MODEL.md) | The concept: two roles, Task Brief contract, four layers, one planning session, runs. No code. |
| [CONCEPTS.md](./CONCEPTS.md) | Concepts & glossary: shared vocabulary used throughout `src/` and the other docs. |
| [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) | The same flow with file paths and function names. CLI entry → stores → TUI → engine → planning → tasks → review. |
| [WORKFLOW.md](./WORKFLOW.md) | The state machine: every phase, every transition, the run contract, stopping and continuing, rewind. |
| [ENGINE.md](./ENGINE.md) | The orchestrator, EventBus, sinks, callbacks vs events, abort handling, message queue. |
| [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) | Four runner kinds, planner/implementer interfaces, Task Brief structure, token accounting. |
| [STORES-AND-UI.md](./STORES-AND-UI.md) | Store factory, store groups, how events reach React, screens, overlays. |
| [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md) | The plan card, protected-path confirmation, the retry-and-consult ladder, recovery system, drift detection. |
| [SUBSYSTEMS.md](./SUBSYSTEMS.md) | Hooks, snapshots, repo-map, runtime commands, detection, compaction, evidence ledger, session lifecycle. |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | How the code is organized: design rationale plus a verified inventory of events, commands, paths, and public API surface. |

## Doing things

| You want to… | Go to |
|---|---|
| Get SPLITBRIEF running | [GETTING-STARTED.md](./GETTING-STARTED.md) |
| Add a command, event, store, or backend | [EXTENDING.md](./EXTENDING.md) |
| Look up a CLI command or flag | [CLI-REFERENCE.md](./CLI-REFERENCE.md) |
| Look up a slash command | [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) |
| Configure SPLITBRIEF | [CONFIGURATION.md](./CONFIGURATION.md) |
| Fix something | [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) |
| See recipes and examples | [USAGE-EXAMPLES.md](./USAGE-EXAMPLES.md) |
| Write or run tests | [TESTING.md](./TESTING.md) |
| Install the pipeline as agent skills | [SKILLS.md](./SKILLS.md) |
| Develop SPLITBRIEF with SPLITBRIEF itself | [DOGFOODING.md](./DOGFOODING.md) |
| Cut a release | [RELEASING.md](./RELEASING.md) |

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
| The SOTA review bar: judgment calls no grep gate catches | [CODE-STANDARD.md](./CODE-STANDARD.md) |

## Deep dives

Specialized subsystem docs linked from the main chapters above.

- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — Workflow hook schema, dispatch, substitution, trust model
- [REPOMAP.md](./REPOMAP.md) — Repo-map: PageRank, token budgeting, SQLite cache
- [TASK-CONTRACT.md](./TASK-CONTRACT.md) — Plan contract, Task Brief schema, plan checks, evidence
- [BOOTSTRAP.md](./BOOTSTRAP.md) — Startup steps and ordering
- [API-KEYS.md](./API-KEYS.md) — Provider keys and secret hygiene
- [AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md) — Which authentication method SPLITBRIEF can enforce, per CLI tool
- [DEBUGGING.md](./DEBUGGING.md) — Diagnosing failures, log locations
- [WORKFLOW-CONVERSATION-SCROLL.md](./WORKFLOW-CONVERSATION-SCROLL.md) — Row-based scroll model for the workflow conversation

## Direction and history

- [VISION.md](./VISION.md) — Product north star
- [DIRECTION.md](./DIRECTION.md) — UX principles, engineering decisions
- [FUTURE.md](./FUTURE.md) — Open questions, longer-horizon backlog
- [FEATURES.md](./FEATURES.md) — Feature catalog
- [CHANGELOG.md](../CHANGELOG.md) — Release notes
- [MIGRATION.md](./MIGRATION.md) — Migration guides: the 2026-04-20 EventBus release and the 2026-09 run contract
- [IMPLEMENTER-DIRECTION.md](./IMPLEMENTER-DIRECTION.md) — Implementer direction

## Project-level

- [`../README.md`](../README.md) — Install and quick start
- [`CLAUDE.md`](https://github.com/b4r7x/splitbrief/blob/main/CLAUDE.md) — Agent instructions
- [`CONTRIBUTING.md`](https://github.com/b4r7x/splitbrief/blob/main/CONTRIBUTING.md) — Development setup
