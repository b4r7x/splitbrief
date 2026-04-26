# Tiered Approval Gates — 2026-04-26

> **Status:** draft spec.
> **Scope:** add action-level tiered approval gates that run orthogonally to the existing document-level approval loop. Destructive, out-of-scope, and network actions are classified and gated before the implementer is allowed to proceed.
> **Out of scope:** replacing or modifying the existing `src/engine/orchestrator/approval.ts` spec/plan/briefs review loop; ML-based rejection-pattern learning; per-file diff UX; cross-repository remote approvals.

## Purpose

The existing approval flow (`approval.ts`) gates planner-produced documents (spec, plan, briefs). It does not gate individual implementer writes or subprocess actions. ACE benchmark data shows a 23% critical-error rate on runs where out-of-scope writes and destructive commands were allowed silently — introducing tiered action-level gates reduced that to 5.1% (78% reduction).

This spec adds an orthogonal gate at the action level:

> Before any implementer write, destructive subprocess call, network call, or package mutation is applied, diptych classifies it into one of three tiers and enforces an appropriate approval protocol.

The two approval systems compose: the document-level loop runs first (planning phase), then tiered action gates run per implementer action (implementation phase).

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Human overview. |
| 2 | `decisions.md` | Product and architecture decisions (ADRs). |
| 3 | `agent-briefs/00-coordinator.md` | Execution order and dependencies. |
| 4 | `agent-briefs/01-action-classifier.md` | Pure classifier: action description → tier. |
| 5 | `agent-briefs/02-approval-gate-engine.md` | Engine-side gate logic, orchestrator integration. |
| 6 | `agent-briefs/03-config-schema.md` | Config schema extension + runtime approvals store. |
| 7 | `agent-briefs/04-tui-approval-prompt.md` | TUI approval prompt component (3 tiers × keyboard options). |
| 8 | `agent-briefs/05-cli-approval-management.md` | `diptych approval list/clear` CLI + `/approval` slash command. |
| 9 | `agent-briefs/06-evidence-rejection-recording.md` | Extend evidence ledger to record rejection events with reasons. |

## Change Set

| # | Brief | Goal |
|---|---|---|
| 01 | Action Classifier | Deterministic classification of implementer actions into auto / sticky / confirm tiers. |
| 02 | Approval Gate Engine | Orchestrator-side gate: classify, consult sticky store, invoke TUI callback or headless policy. |
| 03 | Config Schema | Extend `ConfigSchema` with optional `approval` block; define `ApprovalsStoreSchema` for runtime grants. |
| 04 | TUI Approval Prompt | Inline approval prompt with tier-specific keyboard layouts; no useMemo/useCallback/forwardRef. |
| 05 | CLI Approval Management | `diptych approval list/clear` subcommands + `/approval` slash command. |
| 06 | Evidence Rejection Recording | Schema + helpers to persist rejection events (reason, tier, action, taskId?) in evidence ledger. |

## Why This Comes Now

Brief-quality gating (Phase 1, `2026-04-22-task-brief-evidence-contract`) established that Task Briefs are an executable contract. Action-level gating is the runtime enforcement of that contract: the implementer cannot silently exceed its declared scope.

This spec depends on:
- The evidence ledger introduced in `2026-04-22-task-brief-evidence-contract` briefs 02 (`evidence.ts`, `evidence.json`).
- The brief-quality gate (brief 01) which stores `task.file` and `task.scope` — used by the classifier to determine "in-scope" writes.
- The existing `runPreHooks` / `HookOutcome` pattern in `src/engine/hooks/run-pre-hook.ts`, which tiered approval composes with.

## Shared Context For Agents

- Project: `diptych`, Node 22+, TypeScript, ESM-only.
- UI: Ink 6 + React 19. No `useMemo`, `useCallback`, `React.memo`, `forwardRef`.
- Tests: Vitest 4, colocated (`foo.test.ts` next to `foo.ts`).
- Engine must not import React/Ink/features.
- Existing approval loop lives in `src/engine/orchestrator/approval.ts` — do not modify it.
- Existing hook system: `src/engine/hooks/dispatch.ts`, `run-pre-hook.ts`, `types.ts`.
- Session artifacts live under `.diptych/sessions/<id>/`.
- Project-level runtime store: `.diptych/approvals.json` (see brief 03).
- Never run `git add`, `git stage`, or `git commit`.

## Done Criteria

- Every implementer write is classified and tier-enforced before application.
- Auto-tier writes proceed silently.
- Sticky-tier writes prompt once per session per pattern; user choice is persisted to `.diptych/approvals.json`.
- Confirm-tier writes always require user to type the confirmation phrase.
- Every rejection is recorded in `evidence.json` with a reason string.
- Headless mode fails fast at sticky/confirm tier.
- `diptych approval list` and `diptych approval clear` work without the TUI.
- `/approval` slash command inspects and clears sticky grants in the TUI.
- `npm run test-ci` passes (typecheck → lint → test).

## Quality Bar For Implementing Agents

- Zero classes. Pure functions and module-scoped state only.
- ESM `.js` import extensions in every new file.
- No barrels: do not create re-export-only `index.ts` files.
- Add named constants for new session/project artifacts in `src/core/paths.ts`.
- Use `src/lib/fs.ts` helpers (`ensureSecureDir`, `SECURE_FILE_MODE`) for all file writes.
- New engine events: use dedicated type variants (`approval_prompted`, `approval_granted`, `approval_rejected`, `approval_sticky_recorded`). Do not collapse into generic `warning`.
- Tests assert public behavior, persisted artifacts, returned state, and emitted events — not private helper calls.
- Integration points with the orchestrator must be explicit; do not infer behavior from rendered UI text.
- The action classifier is a pure function; test it with fixtures only. No I/O in classifier.
