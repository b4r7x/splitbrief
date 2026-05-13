# Implementation Status — verified 2026-04-21

> **All gaps closed. Full test suite passes: 203 files, 2059 tests, 0 failures.**

## Verification results

```
npm run typecheck  → clean (0 errors)
npm run lint       → 620 files, no issues
npm test           → 203 passed, 2059 passed, 29.57s
```

Forbidden-pattern checks: zero memoization, zero barrels, zero classes, zero engine→React imports.

## Brief-by-brief final status

| Brief | Status | Notes |
|---|---|---|
| 01 — Mode taxonomy | ✅ Complete | All code in place. enums, config, migrate, CLI, settings, resolve. |
| 02 — Instant mode | ✅ Complete | START_INSTANT, events, prompt, dispatcher, base planner. |
| 03 — Speckit phases | ✅ Complete | Phases in enum, state machine handlers, prompts. **Fixed:** WorkflowState schema now declares `clarifications?`, `constitutionFailureReason?`, `analysisResult?`. Path constants moved from `speckit.ts` to `paths.ts`. `phases.ts` already had new phases. |
| 04 — Approve flag | ✅ Complete | APPROVE_LEVELS, resolveApproveLevel, --approve CLI, settings. Archived design also proposed an approval-level runtime command that is not in the current registry. |
| 05 — Planner effort | ✅ Complete | EFFORT_LEVELS, per-backend pass-through, /effort command, settings. Note: real field name is `GenerationCommonFields` not `CommonFields`. |
| 06 — Image passthrough | ✅ Complete | **Fixed:** Added `onFileDrop` prop + `FILE_DROP_PATTERN` to `multiline-input.tsx`. Added `requestAttach`/`requestDetach` to `handlers.ts`. Wired `handleFileDrop` in `input-bar/input-bar.tsx`. `/attach` and `/detach` slash commands already existed. |
| 07 — Git modes settings | ✅ Complete | createBranch, slug, settings catalog, footer badge, task-commit reads correct path. |
| 08 — Downgrade warning | ✅ Complete | **Fixed:** Added `mode_downgrade_advised` event to `events/types.ts`. Added `bus.publish()` in `run.ts` alongside existing store pattern. Added renderer in `event-card.tsx`. |
| 09 — Task contract docs | ✅ Complete (pre-existing) | `docs/TASK-CONTRACT.md` exists with correct schema. JSDoc on `task.ts`. Brief had stale schema — marked SKIP. |
| 10 — Test cleanup | ✅ Complete (no deletions) | All 6 hook tests audited. None qualify for removal — all hooks have non-trivial logic (keyboard routing, async file reads, timing windows, abort controllers). |

## Files modified in this session (to close gaps)

| File | Change |
|---|---|
| `src/core/schemas/workflow.ts` | Added 3 optional fields to WorkflowStateSchema |
| `src/core/paths.ts` | Added CLARIFICATIONS_FILE, CONSTITUTION_CHECK_FILE, ANALYZE_FILE exports |
| `src/engine/orchestrator/planning/speckit.ts` | Replaced local constants with imports from paths.ts |
| `src/components/input/multiline-input.tsx` | Added onFileDrop prop + FILE_DROP_PATTERN detection |
| `src/features/workflow/handlers.ts` | Added requestAttach, requestDetach exports |
| `src/components/input-bar/input-bar.tsx` | Wired handleFileDrop → requestAttach |
| `src/core/slash-commands/context.ts` | Delegated attachImage to requestAttach |
| `src/engine/events/types.ts` | Added mode_downgrade_advised event variant |
| `src/engine/orchestrator/planning/run.ts` | Added bus.publish for mode_downgrade_advised |
| `src/features/workflow/components/event-cards/event-card.tsx` | Added mode_downgrade_advised renderer |

## No changes needed (already correct)

- `src/core/phases.ts` — RESUMABLE_PHASES + CANCELLABLE_PHASES already included new phases
- `src/core/slash-commands/catalog.ts` — /attach + /detach already existed
- All hook tests — none were trivially redundant
