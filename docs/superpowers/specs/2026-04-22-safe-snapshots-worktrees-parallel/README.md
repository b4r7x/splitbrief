# Safe Snapshots, Worktrees & Parallel Execution — 2026-04-22

> **Status:** draft spec.
> **Scope:** safer experimentation at the end of the roadmap: rejectable run snapshots, worktree convenience, and parallel-session guardrails.
> **Out of scope:** Task Brief contract, Smart Intake UX, external handoff rendering.

## Purpose

This spec adds higher-blast-radius workflow features after the core contract and UX are stable.

The safe direction is:

1. file-level run snapshots,
2. worktree-based parallel sessions,
3. clear session registry/status,
4. no concurrent writes in one working tree.

Diptych supports parallel work through isolated checkouts, not by letting multiple agents write the same directory.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Product overview. |
| 2 | `decisions.md` | Safety decisions. |
| 3 | `agent-briefs/00-coordinator.md` | Execution order. |
| 4 | `agent-briefs/01-safe-run-snapshots.md` | Accept/reject run snapshots. |
| 5 | `agent-briefs/02-worktree-start.md` | `diptych start --worktree` convenience. |
| 6 | `agent-briefs/03-parallel-session-registry.md` | List/status across worktrees; guardrails. |

## Change Set

| # | Brief | Goal |
|---|---|---|
| 01 | Safe Run Snapshots | Reject a run without overwriting user edits. |
| 02 | Worktree Start | Start an isolated worktree run with one command. |
| 03 | Parallel Session Registry | View active sessions across worktrees and prevent unsafe same-tree parallelism. |

## Done Criteria

- Users can reject diptych-written files safely.
- User edits after diptych writes are not overwritten.
- Parallel work uses git worktrees.
- Same working tree still allows only one active session.
- Commands never stage or commit.

## Quality Bar For Implementing Agents

- Snapshot restore must be hash-guarded.
- Worktree support must never bypass the existing `.diptych/active` lock inside a checkout.
- Worktree commands can create branches/worktrees but must not stage or commit.
- Prefer explicit refusal with actionable command text over hidden nested process execution.
