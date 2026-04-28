# Verification

## After Each Child Pack

The coordinator should verify:

- The pack stays within its named user moment.
- The pack references the core identity: expensive planner to Task Briefs to cheap/local implementer per task to checkpoints, validation, evidence, and escalation.
- Durable session history remains core.
- Sessions are described as execution records, not plan archives.
- The pack does not introduce kanban, plan management, MCP writes, generic multi-agent management, hidden fan-out, or same-checkout parallel writes.
- Any mention of future parallel execution requires isolated worktrees or equivalent sandboxes and is not near-term.
- The pack distinguishes deterministic guardrails from runner-owned tools.
- User edits are treated as source-of-truth changes that must not be overwritten silently.
- Checkpoints/restores are hash-guarded and preserve later user edits by default.
- Validation expectations are concrete enough for the child pack's scope.
- Readiness persistence follows ADR-005: `diptych doctor` is read-only; `diptych start` may persist compact readiness evidence in the active execution session before model calls.

## Pack-Specific Checks

For `2026-04-28-run-readiness-doctor`, verify readiness signals include blockers, warnings, user choices, and clear separation between read-only `diptych doctor` output and `diptych start` session evidence.

For `2026-04-28-plan-review-trust`, verify approval remains current-session Task Brief review and does not become task-board management.

For `2026-04-28-recovery-flow`, verify every recovery choice explains consequence, affected files/tasks, artifact impact, and whether planner escalation is needed.

For `2026-04-28-checkpoint-review-packet`, verify the final packet ties together evidence, drift, validation, checkpoints, routing, cost, skipped/escalated tasks, and planner review.

## After The Whole Roadmap

The coordinator should synthesize a short completion note that answers:

- Are the four packs consistent with the cost-aware implementer direction?
- Do the packs share terminology for readiness, review, recovery, checkpoints, evidence, drift, and session history?
- Is any child pack accidentally specifying a plan archive, kanban, MCP write surface, multi-agent manager, or same-checkout parallel write path?
- Can a future implementation coordinator execute the packs in order without reopening roadmap-level product decisions?
- Are remaining open questions explicitly assigned to child packs rather than left as roadmap ambiguity?
