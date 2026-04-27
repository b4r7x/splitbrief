# Implementation Plan: Cost-Aware Implementer Pool + Plan Review v2

**Date:** 2026-04-28
**Status:** Historical implementation plan. Final implemented state is recorded in `README.md`, `tasks.md`, `verification.md`, and `docs/COST-AWARE-IMPLEMENTER-HANDOFF.md`.
**Spec:** `spec.md`
**Direction:** `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`

## Summary

Extend diptych's existing planner-to-implementer loop so a plan can be reviewed, sized, routed, and executed safely by cheap workers without bloating a single implementer context. Keep execution sequential in one checkout. Add implementer profiles and routing metadata, improve Plan Review TUI, and replace generic external-change prompts with task/file-aware conflict handling.

## Technical Context

**Language/Version:** TypeScript 6.x, Node.js 22+, ESM only.
**Primary Dependencies:** Ink 6, React 19, Vitest 4, Biome 2, Zod 4, simple-git.
**Storage:** `.diptych/sessions/<id>/state.json`, `tasks.md`, evidence, drift, snapshots.
**Testing:** Vitest colocated tests, `npm run test-ci`.
**Project Type:** CLI/TUI orchestrator.
**Constraints:** No classes, no barrels, no React memoization, no engine imports from UI layers, no staging/commits by agents.

## Constitution Check

| Principle | Result | Notes |
|---|---|---|
| Cost-Optimal Orchestration | Pass | This feature directly supports cheaper implementation. |
| Spec-Driven Development | Pass | This pack provides spec, plan, tasks, analyze, and agent briefs. |
| Local-First Implementation | Pass | Local implementers remain preferred when they fit. |
| Functional Purity | Pass | New logic should be pure functions plus existing stores. |
| Validate Before Commit | Adjusted | This repo forbids agent commits. Validate before completion, not before commit. |
| Identity & Anti-Goals | Pass with guardrail | Implementer pool is selection/fallback, not a dynamic swarm. |

## Project Structure

### Documentation

```text
docs/
├── COST-AWARE-IMPLEMENTER-DIRECTION.md
└── superpowers/specs/2026-04-28-cost-aware-implementer-pool-plan-review-v2/
    ├── README.md
    ├── decisions.md
    ├── spec.md
    ├── implementation-plan.md
    ├── tasks.md
    ├── analyze.md
    ├── cleanup.md
    ├── verification.md
    └── agent-briefs/
```

### Expected Source Touch Areas

```text
src/core/schemas/
  config.ts
  implementer-config.ts
  summary.ts
  tokens.ts
  task.ts

src/core/config/
  load/*
  runtime/*
  accessors/*

src/engine/orchestrator/
  task-loop.ts
  task-step.ts
  types.ts
  events.ts
  cost-prediction.ts
  tiered-approval.ts

src/engine/spec/
  formatter.ts
  token-budget.ts
  brief-quality.ts

src/engine/implementers/
  types.ts
  base.ts
  cli.ts
  api.ts
  shell.ts
  agent.ts
  agent-sdk.ts

src/features/workflow/
  components/*
  hooks/*

src/stores/workflow/
  plan-editor.ts
  tasks.ts
  tokens.ts
  events.ts
```

## Phase 1 - Direction and Cleanup Framing

Document the direction and update docs so future agents do not implement the wrong product:

- cost-aware planner-to-implementer orchestration,
- implementer pool as selection/fallback,
- no plan archive/kanban/cross-plan system,
- no same-directory parallel writes,
- runner-owned tools,
- read-only diptych MCP,
- checkpoints over commits in this repo.

## Phase 2 - Implementer Profiles

Add a backwards-compatible config layer:

- existing `implementer` remains valid,
- optional profiles can be configured,
- every profile resolves to the existing `ImplementerConfig` shape plus metadata,
- profile names are stable and renderable in TUI/events,
- default profile selection is deterministic.

Avoid broad abstraction. A small helper such as `resolveImplementerProfiles(config)` is enough.

## Phase 3 - Task Sizing and Routing

Add pure helpers that:

- build or estimate the task prompt before dispatch,
- compare estimate against profile context length with a safety margin,
- classify fit as `fits`, `tight`, or `overflow`,
- choose the cheapest capable profile,
- record why alternatives were rejected.

Routing should be deterministic and testable without running real models.

## Phase 4 - Sequential Scheduler Integration

Keep `runTaskLoop` sequential, but route before every task:

```text
for task in tasks:
  refresh code context
  estimate prompt
  choose implementer profile
  create pre-task checkpoint if enabled
  dispatch fresh worker call
  validate
  record evidence/routing/cost
```

Do not implement parallel fan-out in this spec.

## Phase 5 - User Edit Conflict Model

Replace generic external-change handling with a structured model:

- dirty-at-start files,
- external changes since task start,
- task files affected,
- future task files affected,
- unrelated files.

Add events/callbacks so TUI can show choices:

- continue unrelated,
- pause,
- regenerate/rebase affected task,
- skip task,
- abort workflow.

Reuse existing snapshot/staging primitives where possible.

## Phase 6 - Plan Review v2 TUI

Extend existing plan editor rather than replacing it:

- task list with status/fit/worker/risk,
- selected task detail with file ownership and validation,
- cost/context estimate overlay,
- conflict/stale markers,
- actions for edit/split/merge/delete/reorder/regenerate feedback/approve.

Keep the UI terminal-native and dense.

## Phase 7 - Tool/MCP Boundary and Test Cleanup

Update docs and tests:

- tool calls belong to underlying runners,
- diptych MCP remains read-only,
- remove or rewrite low-value tests that assert implementation details or no-crash behavior,
- keep behavior tests around routing, conflict protection, plan save, validation, and artifacts.

## Complexity Tracking

| Complexity | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Implementer profiles | Different cheap workers have different context/cost limits | One implementer forces users to overpay or overflow context. |
| Routing decisions | Users need to trust why a worker was selected | Hidden selection makes cost and failure hard to debug. |
| Structured conflicts | Manual user edits must not be overwritten | A yes/no external-change prompt does not tell users what is at risk. |
| Plan Review v2 metadata | Users must see context/cost risk before execution | A plain task list hides the most important execution risks. |

## Deferred

- Plan archive/search.
- Visual kanban.
- Cross-plan orchestration.
- Same-directory parallel writes.
- Automatic merge across workers.
- MCP write tools.
- Broad cleanup/removal of snapshots, worktrees, handoff, or detached sessions without separate decisions.
