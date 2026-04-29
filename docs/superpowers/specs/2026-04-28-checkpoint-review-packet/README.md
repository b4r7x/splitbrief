# Checkpoint / Restore UX + Post-run Review Packet - 2026-04-28

> **Status:** v1 implemented as of 2026-04-29.
> **Scope:** checkpoint visibility, restore trust copy, and a session-local post-run review packet.
> **Write scope for this pack:** source implementation plus `docs/superpowers/specs/2026-04-28-checkpoint-review-packet/**`.
> **Out of scope:** kanban, plan archive, MCP write tools, full multi-agent manager, same-checkout parallel writes, automatic restore, and PR-provider integrations.

## Problem

Diptych already has durable sessions, hash-guarded snapshots, evidence, drift detection, final planner review, and a summary screen. The trust problem is that these signals are scattered across artifacts and CLI commands. Users need a clear answer at the end of a run:

- What changed?
- Which checkpoints exist and how can I inspect or restore them?
- What validation and evidence support the change?
- What recovery decisions were made or left unresolved?
- What escalated, drifted, failed, or still needs human review?
- What should a PR reviewer check next?

## Scope

This pack specifies two connected UX improvements:

1. **Checkpoint / restore visibility:** expose existing snapshot checkpoints in user-facing run surfaces without changing the underlying snapshot safety model.
2. **Post-run review packet:** write a session-local packet that ties together changed files, validation, evidence, drift, checkpoints, recovery decisions, escalations, cost/routing, final planner review, and a human reviewer checklist.

This is session UX. It is not a saved plan library or project-management system.

## Baseline References

- `docs/FEATURES.md`
- `docs/WORKFLOW.md`
- `docs/superpowers/specs/2026-04-26-snapshots-undo/README.md`
- `src/engine/snapshots/*`
- `src/features/summary/screen.tsx`
- `src/features/summary/components/*`
- `src/engine/orchestrator/final-review.ts`
- `src/engine/orchestrator/evidence.ts`
- `src/engine/orchestrator/drift.ts`

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Problem, scope, non-goals, and pack map. |
| 2 | `spec.md` | Product behavior and acceptance criteria. |
| 3 | `decisions.md` | ADR-style product and architecture decisions. |
| 4 | `implementation-plan.md` | Implemented source areas, validation focus, and deferred polish. |
| 5 | `tasks.md` | v1 implementation checklist and remaining deferred items. |
| 6 | `verification.md` | Current validation guide and shared-checkout test limits. |
| 7 | `agent-briefs/00-coordinator.md` | Historical coordinator prompt for fresh implementation contexts. |
| 8 | `agent-briefs/01-checkpoint-ux.md` | Checkpoint visibility and restore trust worker brief. |
| 9 | `agent-briefs/02-review-packet-model.md` | Review packet artifact/model worker brief. |
| 10 | `agent-briefs/03-summary-tui.md` | Summary screen rendering worker brief. |
| 11 | `agent-briefs/04-tests-and-validation.md` | Final validation and test-hardening worker brief. |
| 12 | `execute-prompt.md` | Copy/paste prompt for handing this pack to a fresh implementation context. |

## Non-Goals

- Do not build kanban.
- Do not build a plan archive, saved-plan library, cross-plan dependency tracker, or plan-management workflow.
- Do not build MCP write tools.
- Do not build a full multi-agent manager.
- Do not support parallel writes in one checkout.
- Do not replace git, final planner review, evidence, or drift detection.
- Do not make restore automatic or silent.

## Current v1 Behavior

- User-facing checkpoint summaries are built from snapshot manifests and the run ledger.
- Baseline snapshots stay hidden from normal checkpoint UX.
- Restore and diff commands use snapshot IDs.
- Name-derived checkpoint labels are shown as inferred, not as proof that a snapshot belongs to the run ledger.
- The run writes `review-packet.json` and `review-packet.md` under the current session directory.
- The summary screen shows compact checkpoint and review packet rollups.
- Missing artifacts are recorded explicitly in the packet.
- Restore stays explicit and hash-guarded; no automatic restore was added.
