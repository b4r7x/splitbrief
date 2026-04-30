# Spec

## Problem

Diptych already has the core cost-aware direction: expensive planner, cheaper implementer, task briefs, routing, checkpoints, and review.

The next improvement is trust.

Users should quickly understand:

- what they are about to spend,
- why a task goes to a certain implementer,
- what was saved,
- whether their profile config is good enough,
- where a run needs review,
- and what happened after the run.

This should not add noisy popups or extra planner calls by default.

## Personas

### Cost-Conscious Developer

Wants to use a strong planner but avoid paying strong-model prices for every implementation token.

### Power User With Multiple Implementers

Has local, cheap, and stronger implementer profiles and wants routing to be explainable.

### New User

Has partial config. They should not be blocked by missing optional metadata if diptych can continue safely.

## User Stories

### US1 - See Savings After A Run

As a user, I want a clear cost summary after a run so I know whether diptych saved money.

Acceptance:

- show actual planner cost, actual implementer cost, total actual cost,
- show all-planner baseline,
- show estimated savings amount and percentage,
- show local/cheap completion rate,
- show task-level cost/routing evidence in artifacts.

### US2 - See A Cheap Estimate Before A Run

As a user, I want a deterministic estimate before execution so I can decide whether the plan is worth running.

Acceptance:

- no LLM call required,
- uses planned tasks, routing preview, provider pricing, token estimate, and context fit,
- output is stable for the same inputs,
- clearly marks unknown prices or low-confidence profile metadata.

### US3 - Ask Planner To Review The Estimate

As a user, I may want the smarter planner to critique the deterministic estimate when cost matters.

Acceptance:

- opt-in only,
- uses a compact packet, not the full repo context,
- can say "estimate seems fine", "split these tasks", "risk: cheap implementer likely fails", or "needs user decision",
- cost of this review is visible or at least marked as an additional planner call.

### US4 - Auto-Split Only Overflowing Tasks

As a user, I want diptych to split tasks only when they do not fit a selected cheap implementer.

Acceptance:

- opt-in only,
- targets specific overflowing or high-risk tasks,
- preserves task intent and acceptance criteria,
- shows resulting task changes before execution,
- never silently rewrites the whole plan.

### US5 - Doctor Is Helpful But Quiet

As a user, I want normal runs to avoid warning popups, but `doctor` to tell me what is incomplete.

Acceptance:

- blockers stop normal runs,
- warnings do not interrupt normal start,
- `doctor` shows blockers, warnings, info, and confidence,
- missing optional metadata is a warning or info, not a blocker,
- missing required credentials for the only usable implementer is a blocker.

### US6 - Optional Task Review Gate

As a user, I may want to pause after every task to inspect the result before continuing.

Acceptance:

- default is off,
- modes: `none`, `failed`, `every`,
- review shows task id, files touched, validation result, evidence, cost, and commands,
- commands include continue, redo, edit/notes, revise plan, abort,
- does not replace final review.

### US7 - Explain The Run

As a user, I want a compact explanation of decisions after the run.

Acceptance:

- explains routing choices,
- explains context-fit fallback,
- explains cost estimate confidence,
- explains review gates triggered,
- references artifacts instead of dumping huge text.

## Functional Requirements

### ORCH-001 - Cost Summary

Post-run summary must include planner cost, implementer cost, total actual cost, all-planner baseline, savings amount, savings percentage, and local/cheap completion rate when data is available.

### ORCH-002 - Task-Level Cost Evidence

Each task summary should preserve enough routing/cost metadata to explain why the task was cheap, expensive, local, skipped, retried, or escalated.

### ORCH-003 - Deterministic Estimate

Add a no-LLM estimate path that can run before implementation. It should reuse existing routing and pricing code instead of adding a separate cost model.

### ORCH-004 - Estimate Confidence

Estimate output must distinguish:

- known price,
- unknown price,
- known context length,
- inferred context length,
- conservative fallback context length,
- unavailable profile.

### ORCH-005 - Planner Estimate Review

Add optional planner review for estimates. It must be behind explicit config/CLI/TUI choice and must not be the default path.

### ORCH-006 - Auto-Split Overflow

Add optional auto-split for context overflow. It should split only targeted tasks and require review before execution.

### ORCH-007 - Profile Doctor

Extend existing readiness/doctor behavior instead of creating a second diagnostic system.

### ORCH-008 - Silent Warnings In Normal Start

Normal interactive start should show blockers only. Warnings should be accessible through doctor, JSON, trace, or explicit details.

### ORCH-009 - Task Review Gate

Add optional task review after task completion according to `taskReview` mode.

### ORCH-010 - Trace Explain

Add a compact explain surface that reads existing session artifacts and outputs human-readable reasoning.

## Non-Goals

- No automatic benchmark/calibration loop in this pack.
- No generic agent swarm.
- No same-checkout parallel writes.
- No automatic worktree merge system.
- No automatic git staging or commits.
- No new React Context for workflow state.
- No low-value tests for tiny hook wrappers.

## Edge Cases

- No pricing for selected profile: estimate still works but marks cost unknown.
- No context length for selected profile: use conservative fallback and mark low confidence.
- API key missing for unused profile: warning only.
- API key missing for only usable profile: blocker.
- Planner estimate review fails: deterministic estimate remains usable.
- Auto-split creates too many tiny tasks: block and ask user to review.
- User edits plan after estimate: estimate must be stale or refreshed before execution.
- Task review is enabled in headless mode: output must be machine-readable or reject unsupported interactive mode clearly.

## Success Criteria

- A new user can understand cost and routing without reading source code.
- A power user can debug profile readiness with `doctor`.
- A cost-conscious user can keep planner review off by default.
- Implementation remains split into bounded modules with behavior tests.
- The main coordinator can review the work without carrying every source file in context.
