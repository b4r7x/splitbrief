# Cost-Aware SOTA Orchestration - 2026-04-29

> **Status:** proposed implementation pack. No product code has been changed by this pack.
> **Scope:** make diptych easier to trust and worth using as a cost-saving planner-to-implementer orchestrator.
> **Out of scope:** automatic model benchmarking, automatic model reassignment without user opt-in, same-checkout parallel writes, automatic git staging/commits, and a generic multi-agent swarm.

## Why Superpowers, Not Spec Kit

Use this as a **superpowers spec pack**.

This project already uses superpowers packs for bounded implementation handoffs. That is the better fit here because the goal is to hand separate, small contexts to cheaper agents, not to run one large implementation conversation.

This folder is the coordinator/index pack. The implementation work is split into **seven self-contained specs** under `implementation-specs/`.

Each `implementation-specs/*/SPEC.md` is designed to be pasted into a fresh, cheaper AI context.

The coordinator pack still follows the Spec Kit thinking path:

```text
spec.md -> implementation-plan.md -> tasks.md -> verification.md -> agent-briefs/*
```

## Product Direction

Diptych remains:

```text
expensive planner -> self-contained Task Briefs -> cheap implementer workers -> checkpoint -> validate -> review
```

The new work should improve trust, cost visibility, and review control without bloating the main context or turning diptych into a generic agent platform.

Default behavior should stay cheap and deterministic. Any step that calls the smarter planner for extra judgment must be explicit opt-in.

## Required Skills

Main coordinator context should use these skills as guidance:

- `react-senior-guide`
- `code-audit` as a checklist only; do not run a full audit unless explicitly requested.
- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `parallel-agents` for dispatch planning only.

Implementation agents should use the skills listed in their own brief. Every brief repeats the required guardrails so it can be copied into a fresh context.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md` | Product direction and non-goals. |
| 2 | `CLAUDE.md` | Repo rules, architecture, conventions, and git guardrails. |
| 3 | `docs/PRINCIPLES.md` | Architecture, testing, DRY, and state principles. |
| 4 | `docs/HOOKS.md` | Hook depth and test policy. |
| 5 | `docs/TESTING.md` | Behavior-test rules. |
| 6 | `README.md` | This pack overview and execution order. |
| 7 | `spec.md` | User stories, requirements, edge cases. |
| 8 | `implementation-plan.md` | File ownership and integration plan. |
| 9 | `tasks.md` | Speckit-style task list. |
| 10 | `verification.md` | Required validation. |
| 11 | `implementation-specs/01-*/SPEC.md` through `07-*/SPEC.md` | Canonical self-contained implementation specs for seven AI contexts. |
| 12 | `agent-briefs/00-coordinator.md` | Main-context orchestration instructions. |
| 13 | `agent-briefs/01-*.md` through `08-*.md` | Short legacy handoff briefs and final cleanup prompt. Prefer `implementation-specs/*/SPEC.md` for implementation. |

## Implementation Slices

| # | Brief | Goal | Default |
|---|---|---|---|
| 01 | Cost Summary Polish | Make post-run savings and route evidence obvious. | On |
| 02 | Deterministic Estimate | Add a cheap, no-LLM estimate before a run. | On |
| 03 | Planner Estimate Review | Let the user ask the planner to critique the estimate. | Off |
| 04 | Auto-Split Overflow | Split only tasks that cannot fit cheap implementer context. | Off |
| 05 | Profile Doctor Readiness | Make config readiness helpful, quiet, and non-breaking. | On |
| 06 | Task Review Gate | Optional pause after each task for review/edit/redo. | Off |
| 07 | Trace Explain Run | Explain why routing/cost/review decisions happened. | On |

## Canonical Seven Implementation Specs

Use these for the seven separate implementation contexts:

| # | Spec | Context Goal |
|---|---|---|
| 01 | `implementation-specs/01-cost-summary-polish/SPEC.md` | Finish and polish post-run cost/savings evidence. |
| 02 | `implementation-specs/02-deterministic-estimate/SPEC.md` | Add no-LLM deterministic estimate. |
| 03 | `implementation-specs/03-planner-estimate-review/SPEC.md` | Add opt-in smarter planner review of the estimate. |
| 04 | `implementation-specs/04-auto-split-overflow/SPEC.md` | Add opt-in targeted split for overflowing tasks. |
| 05 | `implementation-specs/05-profile-doctor-readiness/SPEC.md` | Make profile readiness quiet in normal start and detailed in doctor. |
| 06 | `implementation-specs/06-task-review-gate/SPEC.md` | Add optional per-task review gate. |
| 07 | `implementation-specs/07-trace-explain-run/SPEC.md` | Add no-LLM trace/explain output. |

Docs/tests quality is not an eighth implementation context. It is a coordinator/final-pass responsibility and each spec includes its own docs/test requirements.

## Deferred Work

Parallel isolated worktrees are deferred.

They can make sense later, but they increase integration cost and require smarter final merge/review. This pack should first make sequential orchestration excellent, inspectable, and cheap. A later pack can propose isolated-worktree execution if real usage shows that sequential task execution is too slow.

## Global Invariants

- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert user changes.
- Do not introduce same-checkout parallel writes.
- Do not add a new runtime dependency unless the implementing brief explicitly justifies it. This pack currently expects none.
- No classes.
- No barrels.
- ESM imports use `.js` suffixes.
- Engine code must not import React, Ink, `src/features/`, `src/components/`, or `src/hooks/`.
- React code must not add `useMemo`, `useCallback`, `React.memo`, `forwardRef`, or derived-state effects.
- Main context should stay small: dispatch bounded briefs, then synthesize results.
- Tests must verify behavior, artifacts, rendered output, config outcomes, and public state, not private helper calls.

## Done Criteria

- A user can see what money was saved after a run.
- A user can see a deterministic estimate before a run without paying for another LLM call.
- A user can opt into smarter planner estimate review when they want to pay for it.
- Missing optional profile metadata does not break normal use.
- Normal start does not show noisy warning popups.
- Doctor mode shows full readiness detail because the user explicitly asked for diagnostics.
- Optional task review lets the user stop after each task without becoming the default.
- Trace/explain output makes routing and cost decisions auditable.
- Docs tell a simple product story: expensive planner, cheap implementer, deterministic guardrails.
