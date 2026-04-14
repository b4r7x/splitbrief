# plans/ — diptych implementation plans

This directory contains the implementation roadmap for the workflow redesign agreed in the design session dated 2026-04-14. Each numbered subdirectory is one self-contained spec in Speckit format (`spec.md`, `plan.md`, `tasks.md`, optional `research.md`) and can be driven by Speckit slash commands (e.g. `/speckit.implement plans/001-capability-matrix`).

**Distinction from `specs/`:** `specs/` holds feature-level Speckit specs authored against the product. `plans/` holds *internal engineering* specs that restructure diptych itself. Same format, different audience.

## The 9 planned specs

Numbered in recommended execution order. Dependencies shown — later specs assume earlier specs are already merged.

| # | Spec | Depends on | What it delivers |
|---|------|-----------|------------------|
| 001 | `001-capability-matrix` | — | `PlannerCapabilities` struct, per-backend declarations, config override for shell/agent kinds |
| 002 | `002-session-storage-restructure` | — | `.diptych/sessions/<id>/` folder model, session-id generation (`<date>-<slug>`), `.diptych/active` lock |
| 003 | `003-session-jsonl-log` | 002 | One `session.jsonl` per session (type-tagged events + messages), `workflow.persistTranscript` opt-out |
| 004 | `004-persist-planner-session-id` | 001, 002 | Dispatch `SET_PLANNER_SESSION_ID`, restore on resume, transcript rebuild fallback when backend rejects id |
| 005 | `005-abort-continuation` | 002, 003 | Ctrl-C single = abort turn, Ctrl-C double = exit, `awaitingContinue` sub-state, `AbortController` propagation for all backends |
| 006 | `006-soft-rewind-commands` | 002 | `/revise-spec`, `/revise-plan`, `/redo-task` slash commands |
| 007 | `007-queue-mid-phase` | 003, 005 | `workflowStore.messageQueue`, safe-point drain, parallel native-session injection for capable backends |
| 008 | `008-clarifications-via-queue` | 007 | Route clarification answers through the queue so they reach the live planner session immediately |
| 009 | `009-migration-and-docs-finalization` | all above | CHANGELOG, migration guide for users with existing `.tiny-spec/` dirs, final pass across README / docs |

## Dependency graph

```
           001 ──────────────► 004
                                 │
002 ──┬──► 003 ──► 005 ──► 007 ──┴─► 008
      │     │       │                │
      │     └───────┘                │
      │             │                │
      ├──► 004 ─────┘                │
      │                              │
      └──► 006                       │
                                     │
all ──────────────────────────► 009 ─┘
```

`001` and `002` are the two foundations. `006` is an independent track buildable any time after `002`. `007` and `008` are the interaction layer and must come last before migration.

## Authoring conventions

Every spec MUST:

1. **Follow Speckit format** — `spec.md` (user stories, FRs, success criteria), `plan.md` (architecture, data model, dependencies), `tasks.md` (atomic tasks numbered `T001…`).
2. **End `tasks.md` with a "Doc Sync" section** — tasks that update `docs/CONCEPTS.md`, `docs/ARCHITECTURE.md`, or `docs/WORKFLOW.md` to reflect the *implemented* state. Docs always describe current code, never future code (see 2026-04-14 decision).
3. **Be self-contained for an empty AI context** — task descriptions must include enough detail (file paths, function names, expected shape) that a fresh agent can execute them without referring back to the design conversation.
4. **Assume prior specs are merged** — do not repeat groundwork from `001`/`002` in later specs.

## Relationship to the docs

`docs/CONCEPTS.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, `docs/FUTURE.md` describe the **target design**. The plans here describe **how to get from current code to that design**. When a spec is implemented, its "Doc Sync" tasks pull the docs into alignment with the new code state.

## See also

- `docs/WORKFLOW.md` — authoritative description of the target workflow
- `docs/CONCEPTS.md` — target terminology
- `docs/ARCHITECTURE.md` — target architecture
- `docs/FUTURE.md` — scope explicitly deferred beyond this roadmap
- `specs/` — historical feature-level Speckit specs (pre-redesign)
