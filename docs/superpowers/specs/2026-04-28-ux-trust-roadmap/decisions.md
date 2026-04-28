# Decisions

## ADR-001 - Use Superpowers Instead Of One Giant Spec Kit Run

**Status:** accepted
**Date:** 2026-04-28

### Context

The roadmap spans readiness, plan review, recovery, and final review artifacts. Each area has different UX risks, affected surfaces, and validation needs.

### Decision

Use a roadmap Superpowers pack with child packs instead of one giant Spec Kit run.

### Consequences

- Future agents can work from bounded context.
- Each child pack can own its own implementation details and validation.
- The coordinator remains responsible for product coherence across packs.
- The roadmap can sequence UX/trust work without forcing all decisions into one large implementation pass.

## ADR-002 - Split The Roadmap Into Four Packs

**Status:** accepted
**Date:** 2026-04-28

### Context

Trust is not one screen. Users need confidence before implementation, at plan approval, during recovery, and at final review.

### Decision

Split the work into four child packs:

1. Run Readiness Doctor
2. Plan Review Trust
3. Recovery Flow
4. Checkpoint Review Packet

### Consequences

- Each pack has a crisp user moment and success condition.
- Readiness signals can feed plan review, recovery, and final review instead of being rediscovered.
- The sequence avoids shipping a polished final packet before the underlying readiness and recovery signals are dependable.

## ADR-003 - Keep Session History Core And Exclude Plan Archive

**Status:** accepted
**Date:** 2026-04-28

### Context

Durable sessions are necessary for resume, audit, handoff, crash recovery, and trust. That need can be mistaken for a request to build plan management.

### Decision

Session history remains core product surface. Users should be able to resume, browse/filter/search previous sessions, and inspect artifacts created by a run.

Do not add a saved-plan archive, plan-management database, kanban board, cross-plan dependency system, or plan cloning workflow.

### Consequences

- Session artifacts remain execution records.
- Plan Review remains scoped to the current session's Task Briefs and readiness.
- Search and browse affordances should answer "what happened in this run?" rather than "manage my project plan backlog."

## ADR-004 - Forbid Parallel Same-Checkout Writes

**Status:** accepted
**Date:** 2026-04-28

### Context

The product depends on file ownership, user-edit detection, checkpoints, validation, and evidence. Multiple workers writing the same checkout would blur attribution and create unsafe conflict semantics.

### Decision

Do not allow parallel writes in one checkout. Do not add hidden worker fan-out, best-of-N racing, or automatic merging of overlapping agent changes.

If future parallel execution is considered, it must be designed separately around isolated worktrees or equivalent sandboxes with explicit file ownership and merge/review boundaries.

### Consequences

- The near-term roadmap stays focused on reliability and trust.
- The implementer pool remains routing/fallback, not swarm execution.
- Checkpoints, evidence, drift, and recovery can keep one clear writer at a time.

## ADR-005 - Keep Doctor Read-Only And Persist Readiness From Start

**Status:** accepted
**Date:** 2026-04-28

### Context

Readiness should be inspectable before execution, and later roadmap packs need evidence that readiness was checked. That must not turn `diptych doctor` into a mutating command.

### Decision

`diptych doctor` is read-only. It may render readiness findings, blockers, warnings, and recommendations, but it must not persist session events or artifacts.

`diptych start` may run or consume readiness checks and persist a compact readiness event or artifact in the active execution session before planner or implementer model calls. Later packs may consume that session evidence for Plan Review, recovery, and checkpoint review.

### Consequences

- Users can probe readiness safely without changing session history.
- Execution sessions can still carry durable readiness evidence once a run starts.
- Roadmap packs must distinguish read-only diagnostics from active execution evidence.
