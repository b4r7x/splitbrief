# Decisions

One ADR per non-obvious product choice. These are stable intent records, not implementation notes.

## ADR-001 — Diptych is a compiler, not a general agent platform

**Status:** accepted
**Date:** 2026-04-22

### Context

The product direction could have become “AI workspace orchestration” or “multi-agent automation.” That is broader than the problem we actually need to solve.

### Decision

Diptych is a **cost-aware task compiler**: planner decides, implementer executes, diptych manages the contract and the evidence.

### Alternatives

- **General agent platform.** Rejected — too broad, too much surface area, and it weakens the product’s cost discipline.
- **Pure planner tool.** Rejected — the value comes from the compiled handoff and execution loop, not planning alone.

### Consequences

- The product optimizes for narrower contracts and clearer outcomes.
- Planner and implementer remain distinct roles.

## ADR-002 — Task Briefs are the core artifact

**Status:** accepted
**Date:** 2026-04-22

### Context

Specs are useful, but making them mandatory would raise cost for simple work.

### Decision

The Task Brief is the primary artifact. Specs are optional and should appear only when the work needs more structure.

### Alternatives

- **Spec-first for every task.** Rejected — too much ceremony for trivial changes.
- **No durable brief.** Rejected — the planner-to-implementer handoff becomes fragile and expensive to debug.

### Consequences

- Small tasks stay cheap.
- Large tasks can still use a spec when it buys down risk.

## ADR-003 — Modes position cost and risk; they do not define the product

**Status:** accepted
**Date:** 2026-04-22

### Context

The product needs multiple presets, but the presets should be a user-facing way to express cost and risk, not separate product lines.

### Decision

Keep `instant`, `quick`, `standard`, and `speckit` as the four presets.

### Alternatives

- **Fewer modes.** Rejected — the product would lose a useful signal for ceremony level.
- **More modes.** Rejected — the choice surface becomes harder to navigate and less legible.

### Consequences

- Mode choice stays simple.
- The docs can describe a clear progression from low ceremony to high ceremony.

## ADR-004 — Validation, retry, and escalation are part of the contract

**Status:** accepted
**Date:** 2026-04-22

### Context

Execution quality depends on what happens after the first implementation pass.

### Decision

Diptych explicitly owns validation, retry, escalation, and final evidence as part of the workflow.

### Alternatives

- **Let the implementer handle everything.** Rejected — too much responsibility sits in a single opaque step.
- **Only record output.** Rejected — output alone does not tell us whether the result is trustworthy.

### Consequences

- The product can fail usefully, not just silently.
- Users get a clearer trail from request to result.

## ADR-005 — Specs are optional for large or risky work, not a requirement for all work

**Status:** accepted
**Date:** 2026-04-22

### Context

Some changes need a spec. Many do not.

### Decision

Specs are available when the work is large, risky, ambiguous, or compliance-sensitive. They are not the default requirement.

### Alternatives

- **Always require a spec.** Rejected — too slow for the common case.
- **Never use specs.** Rejected — too little structure for serious work.

### Consequences

- The workflow can stay fast for small tasks.
- The product still supports disciplined planning when the risk justifies it.

