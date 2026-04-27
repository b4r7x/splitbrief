# Decisions

## ADR-001 — Task Brief Quality Is A Gate, Not A Suggestion

**Status:** accepted

### Context

The implementer is intentionally cheaper and narrower than the planner. If a Task Brief is vague, the implementer guesses, retries, or escalates.

### Decision

Add a deterministic quality gate after `tasks.md` parsing and before implementation.

### Consequences

- Bad planner output fails early.
- Prompt regressions become visible.
- Users may see a planning failure where diptych previously attempted implementation with a weak brief.

## ADR-002 — Evidence Is Structured, Raw Logs Remain Append-Only

**Status:** accepted

### Context

`session.jsonl` contains all raw events, but it is not a good human review artifact.

### Decision

Create a compact `evidence.json` ledger beside the existing raw transcript. Do not replace `session.jsonl`.

### Consequences

- Summary UI can show evidence without parsing the entire log.
- External tooling can consume a stable-ish review artifact.
- Raw logs remain available for debugging.

## ADR-003 — Drift Detection Is Deterministic First

**Status:** accepted

### Context

Semantic review belongs to the planner. Deterministic checks can still catch common failures cheaply.

### Decision

Detect scope/file/evidence drift with deterministic rules, then pass the report into final planner review.

### Consequences

- Cheap, testable signal.
- No false claim that the checker understands code semantics.
- Planner gets sharper final-review context.

## ADR-004 — Fewer Hook Tests Can Improve Quality

**Status:** accepted

### Context

Direct tests for trivial React hooks often retest React/Ink wiring and make refactors harder.

### Decision

Remove tests for trivial hooks. Keep or rewrite tests for hooks with meaningful observable behavior.

### Consequences

- Lower maintenance burden.
- Behavior coverage remains through consumers and focused hook tests where justified.
