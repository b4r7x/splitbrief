# UX Trust Roadmap - 2026-04-28

> **Status:** implemented through four child packs as of 2026-04-29.
> **Scope:** roadmap-level coordination for UX and trust work across four child spec packs.
> **Out of scope:** runtime implementation details, file-level task briefs, kanban, plan archive or plan management, MCP write tools, generic multi-agent management, same-checkout parallel writes.

## Purpose

This roadmap keeps the next UX/trust work aligned with diptych's core product identity:

```text
expensive planner -> self-contained Task Briefs -> cheap/local implementer per task -> checkpoints/validation/evidence/escalation
```

The child packs improve confidence before, during, and after implementation without turning diptych into project management software or a general agent platform.

## Scope

This pack owns only the roadmap shape:

- which child packs exist,
- the order they should be executed,
- cross-pack invariants,
- coordinator verification after each child pack,
- product decisions that must not be reopened inside child packs without a new ADR.

This roadmap intentionally uses only `README.md`, `decisions.md`, `tasks.md`, `verification.md`, and coordinator prompts; child packs carry the implementation `spec.md` and `implementation-plan.md` files.

Each child pack owns its own requirements, implementation plan, detailed task briefs, tests, and validation commands.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md` | Canonical product boundary and non-goals. |
| 2 | `docs/FEATURES.md` relevant sections | Current workflow, plan review, cost telemetry, sessions, snapshots, evidence, drift, and MCP/read-only surfaces. |
| 3 | `docs/superpowers/specs/2026-04-28-cost-aware-implementer-pool-plan-review-v2/README.md` | Implemented baseline this roadmap builds on. |
| 4 | `docs/superpowers/specs/2026-04-28-cost-aware-implementer-pool-plan-review-v2/decisions.md` | Existing ADRs that remain binding. |
| 5 | `README.md` | Roadmap purpose, order, non-goals, and invariants. |
| 6 | `decisions.md` | Roadmap ADRs. |
| 7 | `tasks.md` | High-level implementation sequence across child packs. |
| 8 | `verification.md` | Coordinator verification checklist. |
| 9 | `agent-briefs/00-coordinator.md` | Prompt for a future coordinator agent. |
| 10 | `execution-order.md` | Exact order and loop for executing the implementation packs. |

## Execution Order

1. `2026-04-28-run-readiness-doctor`
2. `2026-04-28-plan-review-trust`
3. `2026-04-28-recovery-flow`
4. `2026-04-28-checkpoint-review-packet`

This order has now been executed. It was intentional: first make readiness visible, then improve approval trust, then make recovery understandable, then package the final review/checkpoint evidence.

## Non-Goals

- Do not build kanban.
- Do not build a plan archive, saved-plan library, plan cloning workflow, or plan-management system.
- Do not add MCP write tools or mutation endpoints.
- Do not build a full multi-agent manager.
- Do not introduce hidden background fan-out.
- Do not run multiple workers writing the same checkout.
- Do not frame parallel execution as near-term work.

Future parallel execution, if ever reconsidered, must use isolated worktrees or equivalent sandboxes with explicit ownership boundaries.

## Global Invariants

- Durable session history is core: resume, browse/filter/search previous sessions, and inspect session artifacts.
- Sessions are execution records, not a plan archive.
- Plan Review is scoped to the current session's Task Briefs and execution readiness.
- Task Briefs must stay self-contained enough for cheap/local implementers to execute with fresh context.
- Diptych owns deterministic guardrails: checkpoints, validation, evidence, drift, conflict detection, cost and budget signals, and escalation.
- `diptych doctor` is read-only and does not persist readiness state; `diptych start` may persist compact readiness evidence in the active execution session before model calls.
- Tool calls belong to the configured planner or implementer runners.
- Checkpoint restore and run rejection must preserve later user edits by default.
- Same-checkout parallel writes are forbidden.
- This repository's agent rule still applies: do not stage, commit, stash, or revert user changes.

## Child Pack List

| Pack | Goal |
|---|---|
| `2026-04-28-run-readiness-doctor` | Explain whether a run is ready before expensive or risky execution begins. |
| `2026-04-28-plan-review-trust` | Make Task Brief approval feel inspectable, editable, and evidence-backed without becoming kanban. |
| `2026-04-28-recovery-flow` | Make failures, conflicts, retries, skips, aborts, and restores understandable and hash-guarded. |
| `2026-04-28-checkpoint-review-packet` | Produce a clear end-of-run packet tying checkpoints, evidence, drift, validation, cost, and planner review together. |
