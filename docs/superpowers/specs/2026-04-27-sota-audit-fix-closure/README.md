# SOTA Audit Fix Closure - 2026-04-27

> **Status:** draft spec.
> **Scope:** Close the implementation gaps found in the 2026-04-27 audit of the specs dated 2026-04-22 through 2026-04-26. This is a corrective spec, not a new product expansion.
> **Out of scope:** New workflow modes, remote attach, multi-client read-only fan-out, new runner implementations, new runtime dependencies, and cosmetic UI redesigns.

## Purpose

The 2026-04-22 and 2026-04-26 specs landed most of the intended modules, but several contracts are still partial:

- detached workflows do not preserve the same interactive semantics as inline workflows,
- approval and brief quality gates are not always hard gates,
- plan editor and config loading have correctness bugs,
- cost telemetry has UI pieces but does not receive real per-phase/cache data in production,
- MCP, snapshots, worktrees, and handoff artifacts diverge from their acceptance criteria,
- docs and tests overstate coverage in a few places.

This spec turns the audit findings into implementation-ready briefs that can be assigned to parallel subagents. Each brief is narrowly scoped and has explicit file ownership to reduce merge conflicts.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Human overview and done criteria. |
| 2 | `decisions.md` | Architecture decisions for the closure work. |
| 3 | `agent-briefs/00-coordinator.md` | Execution order, collision map, and shared invariants. |
| 4 | `agent-briefs/01-detach-and-approval-semantics.md` | Detached workflow semantics and pre-apply approval gates. |
| 5 | `agent-briefs/02-task-brief-planning-contract.md` | Task Brief hard gates, review flow, evidence, brief hashes, smart intake. |
| 6 | `agent-briefs/03-config-palette-plan-editor.md` | Lossless config merge, custom palette actions, plan editor correctness. |
| 7 | `agent-briefs/04-cost-telemetry-tui.md` | Real production cost/cache telemetry and always-visible status. |
| 8 | `agent-briefs/05-artifacts-mcp-handoff.md` | MCP manifest and external handoff artifact correctness. |
| 9 | `agent-briefs/06-snapshots-worktrees.md` | Snapshot/worktree acceptance gaps. |
| 10 | `agent-briefs/07-docs-and-test-policy.md` | Documentation drift and behavior-test cleanup. |

## Change Set

| # | Brief | Goal | Parallelism |
|---|---|---|---|
| 01 | Detach and Approval Semantics | Preserve interactive workflow semantics in detached mode; enforce approvals before writes. | Run after 03 if config merge touches approval config. |
| 02 | Task Brief Planning Contract | Make Task Brief gates and review approvals truly blocking; propagate evidence and brief hashes. | Can start early; coordinate on `task-step.ts` with 01. |
| 03 | Config, Palette, Plan Editor | Preserve optional config sections and fix TUI/editor correctness bugs. | Foundation brief; safe to run first. |
| 04 | Cost Telemetry TUI | Wire real per-phase cost/cache data and status/drilldown UI. | Depends on 03 only if config merge affects budget config. |
| 05 | Artifacts, MCP, Handoff | Fix canonical MCP manifest and handoff manifest/validation output. | Independent. |
| 06 | Snapshots, Worktrees | Close snapshot ledger, gitignore, worktree dirty guard, registry, and detach/worktree behavior. | Coordinate `start.ts` with 01. |
| 07 | Docs and Test Policy | Align docs with actual behavior and remove implementation-spy tests. | Last. |

## Done Criteria

- `diptych start`, `start --detach`, `attach`, `detach`, `ps`, and `start --worktree` satisfy the current specs without changing normal inline UX.
- Tiered approval runs before any implementer write is applied; denial leaves the worktree unchanged for that action.
- Invalid Task Briefs cannot enter implementation in `instant`, `quick`, `standard`, or `speckit`.
- Brief review save/approve reparses and quality-gates the persisted `tasks.md`, with the documented fallback behavior.
- Config loading preserves every supported optional top-level config section.
- Command palette custom actions loaded from config are visible and executable.
- Plan editor operations preserve dependency coherence and report user-facing save/editor errors instead of throwing.
- Cost status and drilldown use real token, cost, and cache data from the store.
- MCP `manifest.json` behavior matches the MCP resources spec in this repo.
- Handoff append mode writes complete manifests and validation commands.
- Snapshot and worktree commands satisfy their acceptance criteria or explicitly document a compatible migration decision.
- Docs do not claim features that are not implemented.
- `npm run test-ci` passes.

## Quality Bar For Implementing Agents

- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Make the smallest correction that satisfies the original spec; do not replace working subsystems.
- Keep engine code free of React, Ink, and feature-layer imports.
- No classes, no barrels, no new memoization, no `forwardRef`, no unnecessary effects.
- Tests assert behavior, artifacts, rendered output, and process results. Do not assert private helper call counts.
- Use existing schemas, stores, and event patterns before adding new abstractions.
- If an old 2026-04-22 acceptance criterion conflicts with a newer 2026-04-26 architecture, preserve the newer architecture and add a compatibility layer rather than reverting it.
