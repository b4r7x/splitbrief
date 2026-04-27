# 01 — Smart Intake & Mode Advisor

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Upgrade the current advisor from trivial keyword detection to a deterministic risk/mode/missing-context classifier.

## Read First

- `CLAUDE.md`
- `docs/WORKFLOW.md`
- `docs/superpowers/specs/2026-04-22-cost-aware-task-compiler/modes.md`
- `src/engine/orchestrator/planning/mode-advisor.ts`
- `src/engine/orchestrator/planning/run.ts`
- `src/features/workflow/components/input-footer.tsx`
- `src/engine/events/types.ts`

## Files To Touch

- `src/engine/orchestrator/planning/mode-advisor.ts`
- `src/engine/orchestrator/planning/mode-advisor.test.ts`
- `src/engine/orchestrator/planning/run.ts`
- `src/engine/events/types.ts`
- `src/features/workflow/components/input-footer.tsx`
- `src/features/workflow/components/input-footer.test.tsx` new
- `docs/WORKFLOW.md`

## Behavior

Classify prompt risk:

```ts
type WorkRisk = 'trivial' | 'small' | 'normal' | 'high';
type ModeAdviceKind = 'none' | 'downgrade' | 'upgrade' | 'missing-context';
```

Mode suggestion:

- `trivial` -> `instant`
- `small` -> `quick`
- `normal` -> `standard`
- `high` -> `speckit`

Signals:

- trivial: typo, rename, formatting, unused import, dead code, comment-only change.
- small: explicit file path, helper, single bug, localized component/command.
- normal: feature, refactor, workflow, multi-file likely, user-visible behavior.
- high: auth, secrets, security, migration, database, config schema, git behavior, hooks, permissions, public API.

Missing context:

- no done criteria,
- vague "improve/fix/make better" with no target,
- non-trivial prompt with no area/file/module,
- no validation hint.

Confidence:

- emit upgrade/downgrade only when confidence >= `0.65`.
- missing-context can emit at lower confidence if prompt is obviously vague.

## UI Copy

Keep footer text short:

- `advisor: likely instant · trivial edit`
- `advisor: consider speckit · security/config risk`
- `advisor: missing done criteria · quick may drift`

Do not render paragraphs.

## Events

Prefer a new event:

```ts
type: 'mode_advice'
kind: ModeAdviceKind
risk: WorkRisk
currentMode: WorkflowMode
suggestedMode: WorkflowMode
confidence: number
factors: string[]
missing: string[]
```

Keep the existing `mode_downgrade_advised` event for backward compatibility. When the new advice is a downgrade, publish both `mode_advice` and `mode_downgrade_advised`. For upgrade or missing-context advice, publish only `mode_advice`.

## Store Contract

Keep the existing module-level advisor subscription pattern:

```ts
setAdvisory(result)
getAdvisory()
subscribeAdvisory(listener)
__resetAdvisoryForTests()
```

Do not introduce React Context or store wrappers around `useSyncExternalStore`.

## Tests

- typo in `standard` suggests `instant`.
- auth/security prompt in `quick` suggests `speckit`.
- vague prompt emits missing context.
- small file-scoped bug suggests `quick`.
- matching selected mode emits `none`.
- low confidence does not upgrade/downgrade.

## Acceptance Criteria

- No LLM/API call.
- Deterministic tests cover risk and mode advice.
- UI shows concise advice.
- No mode auto-switch.

## Verification Commands

```bash
npm test -- src/engine/orchestrator/planning/mode-advisor.test.ts
npm run typecheck
npm run lint
npm test
```
