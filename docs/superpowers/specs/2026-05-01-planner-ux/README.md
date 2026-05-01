# Planner UX Improvements - 2026-05-01

> **Status:** specified
> **Scope:** planner heartbeat, streaming partial output, per-task reject + regenerate, contextual footer keybindings.
> **Write scope for this pack:** source implementation plus `docs/superpowers/specs/2026-05-01-planner-ux/**`.
> **Out of scope:** new planner modes, plan archive, multi-agent orchestration, full streaming rewrite, planner model switching.

## Problem

The planner phase and plan editor are powerful but have UX gaps that erode trust and discoverability:

1. **Dead silence during waits.** When the planner takes >5s (common for speckit mode with large codebases), users see only a bare spinner with an elapsed-seconds counter. No indication of progress, token consumption, or current phase activity.
2. **No streaming visibility for API implementers.** When an API-kind implementer is generating code, output arrives only after completion. Users cannot see partial work in progress.
3. **No per-task rejection.** The plan editor supports bulk approve/reject and full regeneration, but cannot flag individual tasks for targeted re-planning. Users must reject the entire plan or manually edit.
4. **Hidden keybindings.** The plan editor footer is static and does not adapt to context. Users must press `?` to discover available actions, and the footer shows all keys regardless of whether they apply to the current state.

## Scope

This pack specifies four connected UX improvements:

1. **Planner heartbeat:** during long planner waits (>5s), show token count incrementing and current phase hint ("analyzing dependencies...") instead of bare spinner.
2. **Streaming partial output:** show the last 5 lines being written in real-time during API implementer generation.
3. **Per-task reject + regenerate:** flag individual tasks in the plan editor and press `R` to send them back to the planner for targeted regeneration.
4. **Contextual footer keybindings:** footer shows available actions based on current editor state (selection, dirty, expanded, flagged tasks).

## Baseline References

- `src/components/spinner.tsx`
- `src/features/workflow/components/event-cards/planner-status-card.tsx`
- `src/features/workflow/components/agent-status-row.tsx`
- `src/features/workflow/components/event-cards/implementer-card.tsx`
- `src/features/workflow/components/plan-editor.tsx`
- `src/features/workflow/hooks/use-plan-editor-keys.ts`
- `src/stores/workflow/plan-editor.ts`
- `src/stores/workflow/tokens.ts`
- `src/stores/workflow/events.ts`
- `src/engine/streaming/spawn-collect.ts`
- `src/engine/streaming/token-utils.ts`
- `src/engine/orchestrator/planning/run.ts`
- `src/engine/orchestrator/planning/shared.ts`
- `src/engine/orchestrator/planning/regen.ts`
- `src/engine/events/types.ts`

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Problem, scope, non-goals, and pack map. |
| 2 | `decisions.md` | ADR-style product and architecture decisions. |
| 3 | `execute-prompt.md` | Copy/paste prompt for handing this pack to a fresh implementation context. |
| 4 | `agent-briefs/01-planner-heartbeat.md` | Planner heartbeat worker brief. |
| 5 | `agent-briefs/02-streaming-partial-output.md` | Streaming partial output worker brief. |
| 6 | `agent-briefs/03-per-task-reject-regenerate.md` | Per-task reject + regenerate worker brief. |
| 7 | `agent-briefs/04-contextual-footer-keybindings.md` | Contextual footer keybindings worker brief. |

## Non-Goals

- Do not build a new planner mode.
- Do not build plan archive, saved-plan library, or plan-management system.
- Do not rewrite the streaming layer from scratch.
- Do not add MCP write tools.
- Do not add multi-agent parallel writes.
- Do not change planner model selection or routing logic.
- Do not change snapshot/checkpoint semantics.
- Do not add full terminal-width diff rendering during streaming.
- Do not change the approval loop contract (approve/reject/comment) at the orchestrator level.
