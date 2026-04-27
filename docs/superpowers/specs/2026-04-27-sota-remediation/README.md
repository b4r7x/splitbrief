# SOTA Remediation Spec - 2026-04-27

> **Status:** implementation-ready remediation spec.
> **Scope:** Fix all blocking gaps found in the read-only SOTA audit of the current unstaged implementation against specs dated 2026-04-22 through 2026-04-26.
> **Out of scope:** New product features, remote attach, multi-client fan-out, new runner types, new runtime dependencies, cosmetic UI redesign, staging, commits, or stashing.

## Purpose

The current unstaged implementation passes `npm run typecheck`, `npm run lint`, and `npm test` (2971 tests), but it does not satisfy the specs at SOTA 5/5. The failures are mostly semantic: approvals are post-apply, detached mode loses interactive semantics, snapshots can corrupt or over-capture state, MCP does not match current Streamable HTTP expectations, handoff paths are not confined, and several docs/tests overstate behavior.

This spec is written for a fresh AI context and for parallel implementation by subagents. Each brief owns a bounded file set and includes exact required changes.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Overview, execution order, global done criteria. |
| 2 | `decisions.md` | Architectural decisions for fixes. |
| 3 | `AUDIT-FINDINGS.md` | Mandatory source-of-truth findings from the read-only audit. |
| 4 | `agent-briefs/00-coordinator.md` | Parallelization plan and collision map. |
| 5 | `agent-briefs/01-approval-detach-ipc.md` | Approval semantics, detach, detached server behavior. |
| 6 | `agent-briefs/02-snapshots-worktrees.md` | Snapshot safety, run reject, worktree ordering/name validation. |
| 7 | `agent-briefs/03-mcp-handoff.md` | MCP protocol/resource correctness and handoff path safety. |
| 8 | `agent-briefs/04-cost-telemetry.md` | Pricing, cache, budget pause, layout, keybinding tests. |
| 9 | `agent-briefs/05-planning-editor-docs-tests.md` | Planning/rejection context, plan editor, docs, behavior-test cleanup. |
| 10 | `agent-briefs/06-cross-cutting-hardening.md` | Zero-class cleanup, lockfile validation, stale safety regressions. |

## Execution Order

1. Run brief 06 first or in parallel with all others if it only touches isolated safety helpers.
2. Run briefs 01, 02, 03, and 04 in parallel if assigned file ownership is respected.
3. Run brief 05 after 01 and 04 APIs settle because docs/tests must describe final behavior.
4. Run coordinator final verification after all patches are integrated.

## Global Invariants

- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not use destructive git checkout/reset/clean against the user worktree outside existing tests.
- Keep changes unstaged.
- No classes in `src/`.
- No barrels.
- ESM imports must include `.js` suffixes.
- Engine code must not import React, Ink, `src/features/`, `src/components/`, or `src/hooks/`.
- React/Ink code must not add `useMemo`, `useCallback`, `React.memo`, `forwardRef`, or derived-state effects.
- Tests must assert behavior, artifacts, rendered output, public store state, process result, or filesystem effects. Avoid private helper spy/call-count tests.
- Prefer existing schemas/stores/events/helpers over new abstractions.

## Global Done Criteria

- Approval gates protect writes before mutation, or use an equivalent safe staging boundary that guarantees denied writes leave files unchanged.
- Confirm-tier approvals cannot be bypassed by a plain `allow` callback response.
- Confirm approval reasons are recorded where the approval spec promises them.
- `feedRejectionsToPlanner` is wired into real planner calls.
- Detached mode preserves inline workflow prompt semantics and does not auto-answer user decisions.
- `diptych detach` can detach an already attached TUI without killing the server.
- `start --detach` preserves CLI overrides and reports success only when the server is actually accepting IPC clients.
- Snapshot blob storage is collision-free, excludes `.trees/`, validates stored blob hashes before restore, and allows retry after reject conflicts.
- Worktree names are validated and invalid `--detach --worktree` combinations do not create worktrees.
- MCP HTTP transport conforms to current Streamable HTTP MCP behavior or explicitly names and documents a legacy transport. For this remediation, target current MCP compliance.
- MCP/handoff manifests validate against their schemas and never silently omit required fields.
- Handoff overwrite mode starts clean, and renderer paths cannot escape the pack root.
- Cost/budget calculations use selected models, cache pricing is consistent, and status/drilldown agree.
- Docs match implementation exactly after fixes.
- `npm run typecheck`, `npm run lint`, and `npm test` pass. Final target: `npm run test-ci`.

