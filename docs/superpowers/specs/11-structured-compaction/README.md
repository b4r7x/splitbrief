# Structured Compaction — 11

> **Status:** specified, not yet implemented.
> **Scope:** Add structured compaction format with Zod schema and incremental merge alongside existing freeform mode.
> **Write scope:** `src/core/schemas/compaction.ts`, `src/core/sessions/compaction.ts`, `src/engine/planners/base.ts`, `src/core/schemas/config.ts`, colocated tests.
> **Out of scope:** Token-count-based thresholds, always-on compaction, changes to trigger mechanism.

## Problem

Current compaction asks the planner "summarize this" and gets freeform text. Two issues:

1. **No structure guarantees.** The planner may omit critical context (files modified, constraints discovered). After compaction, the orchestrator has less information to work with.
2. **No incremental merge.** Second compaction regenerates from scratch instead of merging with the previous summary. Wastes tokens and loses information from earlier compaction rounds.

## Scope

1. **Two modes:** `freeform` (existing behavior, unchanged) and `structured` (new, Zod-validated JSON).
2. **Auto-detection default:** `auto` mode picks structured for API/agent-sdk planners, freeform for CLI/shell planners.
3. **Structured schema:** `{ goal, stepsCompleted, currentStep, filesModified, constraintsDiscovered, remainingWork }`.
4. **Incremental merge:** In structured mode, second compaction passes previous summary + new messages to planner for merge, not regeneration.
5. **Fallback:** If structured compaction fails Zod validation, fall back to freeform. Log warning, never crash.
6. **Settings UI:** `compactionFormat` selectable from `/settings` overlay.

## Critical design constraint

**Compaction is NOT the main path.** It stays threshold-triggered (`workflow.compactionThreshold`) or manual (`/compact-transcript`). Summary augments recent messages, never replaces them. The implementer always sees `[summary] + [last N raw messages]`, not summary alone.

## Non-Goals

- Do not change when compaction triggers (threshold logic unchanged).
- Do not implement token-count-based thresholds (separate FUTURE item).
- Do not make compaction always-on or automatic without threshold.
- Do not change `keepRecentCount` behavior — last N messages always preserved raw.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Problem, scope, non-goals, critical constraint. |
| 2 | `decisions.md` | Design decisions (two modes, auto-detection, fallback). |
| 3 | `execute-prompt.md` | Copy/paste prompt for implementation context. |
| 4 | `agent-briefs/01-structured-compaction.md` | Full implementation brief. |
