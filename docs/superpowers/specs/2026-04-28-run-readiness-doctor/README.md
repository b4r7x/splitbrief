# Run Readiness / Doctor - 2026-04-28

> **Status:** planned.
> **Scope:** pre-run readiness report for `diptych start` and a reusable doctor command/screen that checks whether a run is safe and worthwhile before planner or implementer tokens are spent.
> **Out of scope:** kanban, plan archive, MCP write tools, full multi-agent manager, same-checkout parallel writes, runtime code changes in this documentation-authoring pass. The agent briefs in this pack are for a future source implementation pass.

## Purpose

Run Readiness gives the user a concise answer before a workflow starts spending tokens:

```text
Can this repo/config/model setup run safely right now, and what should I do next?
```

The report should cover config loading, planner and implementer availability posture, context length sanity, validation command posture, dirty working tree and user-edit risk, optional budget/cost estimate posture, and a clear next action.

This is a pre-run safety feature. `diptych doctor` is strictly read-only and does not persist readiness history. `diptych start` may persist a compact readiness event or artifact inside the active execution session before any model calls. Durable sessions remain execution history and evidence, not project-management tooling or a plan archive.

## Product Boundaries

Preserve the existing direction from `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`:

- expensive planner produces high-quality Task Briefs;
- cheap/local implementer executes small bounded work;
- diptych guards context size, validation, user edits, checkpoints, evidence, cost, and escalation;
- no same-checkout parallel writes;
- no generic agent swarm;
- no MCP write surface.

## Reading Order

Paths in this table are relative to `docs/superpowers/specs/2026-04-28-run-readiness-doctor/` unless they start with `docs/`.

| Step | File | Purpose |
|---|---|---|
| 1 | `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md` | Product non-goals and cost-aware orchestrator identity. |
| 2 | `README.md` | Pack overview, owned scope, slices, done criteria. |
| 3 | `spec.md` | User stories, requirements, edge cases, success criteria. |
| 4 | `decisions.md` | ADRs for command placement, blocking posture, validation, dirty repo handling. |
| 5 | `implementation-plan.md` | Likely source touch areas and phased rollout. |
| 6 | `tasks.md` | Concrete future implementation tasks. |
| 7 | `verification.md` | Targeted commands and manual checks. |
| 8 | `agent-briefs/00-coordinator.md` | Coordinator prompt for a future implementation pass. |
| 9 | `agent-briefs/01-*.md` through `04-*.md` | Bounded worker prompts for fresh AI contexts. |

## Implementation Slices

1. Readiness model and pure checks.
2. CLI integration for `doctor` and pre-start report.
3. TUI/headless presentation and next-action controls.
4. Tests, docs, and regression verification.

## Done Criteria

- `diptych doctor` can run without creating a workflow session or writing implementation artifacts.
- `diptych doctor` does not run config/session migrations or write config; it reports the command or action the user should run when migration or setup is required.
- `diptych start` shows or emits readiness before planner/implementer calls begin and may persist a compact readiness event/artifact in its own active session.
- Readiness uses existing config loading, CLI overrides, mode resolution, implementer profile resolution, validation settings, and cost posture.
- Report has severity levels and one clear next action.
- Blocking is limited to hard local preconditions: invalid config, not a git repo, active-session conflict, or explicitly unsafe dirty-repo condition.
- Warnings do not hide the ability to continue.
- Headless JSON mode emits machine-readable readiness data before workflow events that spend tokens.
- TUI mode shows the report concisely and allows continue/fix/exit behavior without becoming a setup wizard.
- No product scope creep: no kanban, no plan archive, no MCP write tools, no same-checkout parallel writes.
- Implementation respects Node 22+, TypeScript ESM `.js` imports, no classes, no barrels, no memoization, no git stage/commit.
