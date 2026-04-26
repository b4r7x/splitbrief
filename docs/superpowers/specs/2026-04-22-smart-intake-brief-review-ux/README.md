# Smart Intake -> Mode Advisor -> Brief Review UX — 2026-04-22

> **Status:** draft spec.
> **Scope:** design and implement the user-facing planning flow that turns a rough prompt into a reviewed Task Brief without bloating ceremony.
> **Out of scope:** external handoff packs, snapshots/worktrees, evidence schema internals unless consumed as read-only input.

## Purpose

This spec defines the front door of diptych:

```text
rough idea -> local risk/mode advice -> missing-context hints -> Task Brief review -> implementation
```

The goal is planning without planning fatigue. Users should get better plans without being forced into a heavyweight spec flow for every small task.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Product overview. |
| 2 | `decisions.md` | UX and architecture decisions. |
| 3 | `agent-briefs/00-coordinator.md` | Execution order. |
| 4 | `agent-briefs/01-smart-intake-mode-advisor.md` | Deterministic local intake classifier. |
| 5 | `agent-briefs/02-brief-review-gate.md` | Review Task Briefs before implementation. |
| 6 | `agent-briefs/03-cost-risk-ux.md` | Render risk, mode, and cost posture coherently. |

## Change Set

| # | Brief | Goal |
|---|---|---|
| 01 | Smart Intake & Mode Advisor | Replace trivial keyword warning with risk/mode/missing-context advice. |
| 02 | Brief Review Gate | Add a review surface for Task Briefs, quality score, and task scope before implementation. |
| 03 | Cost/Risk UX | Align footer/sidebar/summary copy with cost-aware compiler model. |

## Dependencies

This spec is best after `2026-04-22-task-brief-evidence-contract`, especially the Task Brief quality report. It can still begin independently by rendering existing tasks and advisor data.

## Done Criteria

- Users see mode/risk advice before expensive planning begins.
- Missing context is surfaced without a model call.
- Users can inspect Task Briefs before implementation in modes where review is enabled.
- The UI stays dense and terminal-native.
- No React memoization or context-heavy state is introduced.

## Quality Bar For Implementing Agents

- Add explicit state/event types for new UI states.
- Keep all classification logic pure and unit-tested.
- Do not add a new global React context.
- Small terminal layouts must have tests or pure width helpers.
- Avoid best-effort UI. If a value is unavailable, render a stable fallback label such as `quality n/a` or `risk n/a`.
