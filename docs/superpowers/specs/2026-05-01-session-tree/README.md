# Session Tree Model - 2026-05-01

> **Status:** draft
> **Scope:** append-only tree data model for session entries, branch summarization on recovery, custom heterogeneous entry types, and tree navigation TUI.
> **Write scope for this pack:** source implementation plus `docs/superpowers/specs/2026-05-01-session-tree/**`.
> **Out of scope:** SQLite persistence, DAG/graph topologies, real-time collaborative editing, cross-session merging, automatic branch selection, and tree-based undo/redo UI.

## Problem

Diptych sessions are linear: a flat `session.jsonl` plus a `state.json` snapshot. This linearity creates three concrete trust problems:

1. **Recovery loses context.** When a task fails and recovery retries or reroutes, the failed attempt's decisions, partial progress, and error signals are discarded. The retry starts from scratch with no memory of what was already tried.
2. **No heterogeneous state.** The session log supports only `message` and `event` kinds. Orchestration state that doesn't fit those two shapes (plan steps, cost checkpoints, file-state captures, agent invocations) either lives outside the log or is jammed into opaque `data: z.unknown()` payloads.
3. **No execution topology.** Users cannot see which path was taken, where branches happened, or navigate between alternative execution histories.

## Scope

This pack specifies four connected capabilities:

1. **Append-only tree data model:** entries with `{id, parentId, type, timestamp, payload}`. A `leafId` pointer tracks the active path. Branching = move pointer + append new entries under a different parent.
2. **Branch summarization:** when recovery creates a branch, call the planner LLM to summarize the failed branch (Goal / Progress / Decisions / Constraints / Next Steps) and inject into the retry context.
3. **Custom entry types:** typed entry variants for `plan-step`, `agent-invocation`, `recovery-decision`, `file-state`, `cost-checkpoint` with a `display` flag controlling TUI visibility.
4. **Tree navigation TUI:** ASCII tree viewer showing execution history, active-path markers, fold/unfold, and filter modes.

## Baseline References

- `src/core/sessions/io.ts` — current session read/write
- `src/core/sessions/log-reader.ts` — JSONL streaming reader
- `src/core/sessions/lifecycle.ts` — session ID generation, active tracking
- `src/core/schemas/session-log.ts` — current `SessionLogEntry` discriminated union
- `src/core/schemas/session.ts` — `SessionSchema`
- `src/core/schemas/recovery.ts` — `RecoveryIssue` schema
- `src/engine/events/types.ts` — `EngineEvent` union (pattern for typed variants)
- `src/engine/orchestrator/recovery/actions.ts` — recovery action application
- `src/engine/orchestrator/run/run.ts` — workflow lifecycle

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Problem, scope, non-goals, and pack map. |
| 2 | `decisions.md` | ADR-style architecture decisions. |
| 3 | `agent-briefs/01-tree-data-model.md` | Tree structure, JSONL persistence, append/branch ops. |
| 4 | `agent-briefs/02-branch-summarization.md` | LLM summary of failed branches on recovery. |
| 5 | `agent-briefs/03-custom-entry-types.md` | Typed entry registry, factories, state reconstruction. |
| 6 | `agent-briefs/04-tree-navigation-tui.md` | Ink component: ASCII tree, active path, fold/filter. |
| 7 | `execute-prompt.md` | Copy-paste prompt for opencode coordinator. |

## Non-Goals

- Do not use SQLite or any external database. JSONL is the persistence layer.
- Do not build a DAG or arbitrary graph. Entries form a tree (single parent).
- Do not implement cross-session tree merging.
- Do not implement automatic branch selection or branch ranking.
- Do not implement tree-based undo/redo. Snapshots remain the undo mechanism.
- Do not change the existing `state.json` workflow state machine.
- Do not add real-time collaboration or multi-writer concurrency.
- Do not build a diff viewer inside the tree TUI.
