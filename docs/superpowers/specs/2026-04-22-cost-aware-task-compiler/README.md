# Cost-Aware Task Compiler — 2026-04-22

> **Status:** draft
> **Scope:** new product direction for diptych as a cost-aware task compiler; Task Brief contracts; mode positioning; escalation, validation, and final evidence.
> **Out of scope:** implementation code, schema changes, UI redesign, and broad spec-kit parity work beyond the product framing in this directory.

## Who this doc is for

This spec pack is for readers who need the new product direction in a compact, decision-oriented form.

- Humans should start with `product-brief.md`, then `task-brief-contract.md`, then `modes.md`.
- Implementers should treat the docs here as the source of intent for the new direction, then follow `implementation-plan.md` and the scoped files in `agent-briefs/`.

## Reading order

| Step | File | Purpose |
|---|---|---|
| 1 | `product-brief.md` | The product model: what diptych is now, what it optimizes for, and the core artifact. |
| 2 | `task-brief-contract.md` | The semantic contract between planner and implementer. |
| 3 | `modes.md` | The four mode presets and how they position effort, ceremony, and risk. |
| 4 | `architecture-delta.md` | How the current implementation maps to the pivot target. |
| 5 | `decisions.md` | ADR-style decisions behind the non-obvious product calls. |
| 6 | `implementation-plan.md` | Ordered implementation phases and future agent handoffs. |

## Scope

Diptych is a **cost-aware task compiler for AI coding agents**.

The product uses an expensive planner to decide what should happen, then hands a cheap implementer a narrow Task Brief to execute. Diptych manages the handoff, validation, retry, escalation, and final evidence.

## Non-goals

- Replacing the implementer with a full agent platform.
- Making specs mandatory for every task.
- Turning diptych into a generic multi-agent orchestrator.
- Defining implementation code or repository structure.
- Rewriting existing docs outside this new directory.
