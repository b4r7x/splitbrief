# 01 - Direction Docs Cleanup

> Historical note (2026-04-28): this brief was used during implementation. The current status is recorded in `../README.md`, `../tasks.md`, `../verification.md`, and `docs/COST-AWARE-IMPLEMENTER-HANDOFF.md`.
> Original fresh-context brief retained for audit; do not implement as pending work unless intentionally re-running this spec.
> For the spawned worker assigned this brief: GPT-5.5, medium reasoning.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

Docs-only brief. Align product language with the agreed direction: expensive planner, cheap implementer, checkpoints, validation, user-edited plans, and no generic plan/archive/kanban platform.

## Intent

Make the documentation legible to a less capable future agent. After this brief, a reader should understand that diptych is a cost-aware planner-to-implementer orchestrator, not a project-management system.

## Scope

**In bounds:**

- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `README.md`
- `docs/VISION.md`
- `docs/FEATURES.md`
- `docs/CONCEPTS.md`
- `docs/TASK-CONTRACT.md`
- `.specify/memory/constitution.md`
- Any docs directly touched to remove stale config examples.

**Out of bounds:**

- No source code changes.
- No deletion of feature implementations.
- No changes to generated session files.

## Required Changes

1. Keep the direction doc as the source of truth.
2. Reword docs that imply diptych is a plan archive, kanban board, or generic multi-agent manager.
3. Clarify that implementer pool means profile selection inside one implementer role.
4. Clarify that this repo forbids staging/commits by agents.
5. Refresh stale config examples if they are near edited text.
6. Mark advanced surfaces as advanced where needed: MCP, handoff, worktrees, detach, snapshots.

## Validation

Run:

```bash
rg -n "kanban|archive|cross-plan|swarm|multi-agent manager|commit after each task|git add|git commit" docs README.md .specify || true
rg -n "planner.tool|implementer.provider|api_base|context_length|commit_per_task|auto_approve" README.md docs || true
```

Manually inspect hits. Historical rejected non-goals are allowed if the wording is clear.

## Evidence

- Docs explain the agreed direction without needing this conversation.
- Docs do not instruct agents to stage or commit.
- Config examples touched by this work match current schema.

## Expected Final Report

Include:

- files changed;
- tests or checks run and results;
- validation skipped, with explicit reason;
- remaining risks or follow-up work;
- confirmation that you did not run `git add`, `git stage`, `git commit`, or `git stash`.
