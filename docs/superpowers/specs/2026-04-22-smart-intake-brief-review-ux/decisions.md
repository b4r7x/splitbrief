# Decisions

## ADR-001 — Advisor Is Local And Advisory

**Status:** accepted

### Decision

Smart Intake uses deterministic local heuristics in v1 and never auto-switches modes.

### Rationale

Calling an LLM to decide whether to spend fewer LLM tokens is poor cost discipline. A local classifier catches obvious mode mistakes and missing context cheaply.

## ADR-002 — Brief Review Is A Gate, Not A Markdown Editor

**Status:** accepted

### Decision

The first Brief Review UX lets users inspect, approve, reject, or request regeneration with comments. It does not attempt full inline editing of every Task Brief field.

### Rationale

Inline editing nested Task Brief fields in a TUI has high complexity. Regeneration comments and artifact inspection cover the useful v1 workflow.

## ADR-003 — Dense TUI Over Dashboard UI

**Status:** accepted

### Decision

Risk, mode, quality, and cost signals render as compact rows and event cards, not large explanatory panels.

### Rationale

Diptych is a terminal workflow tool. Users need scanability while agents run, not marketing copy.
