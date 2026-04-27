# Task Brief v1 + Evidence Contract — 2026-04-22

> **Status:** draft spec.
> **Scope:** finish the core compiler contract: Task Brief quality, evidence ledger, brief/code drift detection, and test policy cleanup.
> **Out of scope:** Smart Intake UX, external handoff packs, snapshots, worktrees, production implementation in this planning pass.

## Purpose

This spec makes the planner-to-implementer handoff trustworthy before any new UX or external-agent export is built.

The product invariant is:

> A Task Brief is not just markdown. It is an executable contract. A run is not done until the code, validation, and evidence still match that contract.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Human overview. |
| 2 | `decisions.md` | Product and architecture decisions. |
| 3 | `agent-briefs/00-coordinator.md` | Execution order and dependencies. |
| 4 | `agent-briefs/01-task-brief-quality-gate.md` | Deterministic Task Brief linter/gate. |
| 5 | `agent-briefs/02-evidence-ledger.md` | Persist reviewable evidence per task/run. |
| 6 | `agent-briefs/03-brief-drift-detector.md` | Detect final diff drift from Task Brief scope. |
| 7 | `agent-briefs/04-test-policy-cleanup.md` | Remove low-value hook tests and document policy. |

## Change Set

| # | Brief | Goal |
|---|---|---|
| 01 | Task Brief Quality Gate | Block weak Task Briefs before implementation. |
| 02 | Evidence Ledger | Persist compact proof of task execution, validation, escalation, and review. |
| 03 | Brief/Code Drift Detector | Feed deterministic scope/evidence drift into final planner review. |
| 04 | Test Policy Cleanup | Remove direct tests for trivial hooks and keep behavior-bearing tests. |

## Why This Comes First

Handoff packs, UX review screens, and snapshots are only useful if the core artifact is reliable. This spec tightens the contract first:

- the planner must produce usable Task Briefs,
- the implementer must have enough context to execute without guessing,
- validation/evidence must be durable,
- final review must know whether code drifted from the brief.

## Shared Context For Agents

- Project: `diptych`, Node 22+, TypeScript, ESM-only.
- UI: Ink 6 + React 19.
- Tests: Vitest 4, colocated.
- Core artifact: Product Task Brief v1.
- Markdown transport: `tasks.md`.
- Persisted execution shape: `src/core/schemas/task.ts`.
- Never run `git add`, `git stage`, or `git commit`.

## Done Criteria

- Weak Task Briefs fail before implementation.
- Every completed run writes a compact `evidence.json`.
- Final planner review receives deterministic drift context.
- Test cleanup removes low-value hook tests without losing behavior coverage.
- Docs explain Task Brief, evidence, and testing policy clearly.

## Quality Bar For Implementing Agents

The brief files are intentionally strict. Do not weaken them during implementation.

- Add named constants for new session artifacts in `src/core/paths.ts`.
- Persist JSON artifacts with secure file permissions and deterministic JSON formatting.
- Add dedicated event variants when the spec names one; do not collapse them into generic warnings.
- Prefer pure functions for scoring/report generation and test those directly.
- Integration points must be explicit in the orchestrator; do not infer behavior by parsing rendered UI text.
- Backward compatibility means old session files can be absent, not that new reports can be skipped.
