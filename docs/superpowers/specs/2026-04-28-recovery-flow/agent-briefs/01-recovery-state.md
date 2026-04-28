# 01 - Worker Brief: Recovery Schema And Durable State

Guard: Use this brief only for a future source implementation pass; do not execute it during docs-only pack maintenance.

You are implementing the source-level recovery schema and durable state for diptych / tiny-spec.

This prompt is self-contained for an empty AI context. Run it only after reading the required files. Do not implement recovery issue builders, orchestrator stop points, action handlers, or TUI rendering; those are later briefs.

## Mission

Add a durable recovery issue model to workflow state so later briefs can create, persist, resume, and clear recovery issues without breaking existing sessions.

## Required Reading

- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/WORKFLOW.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/spec.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/implementation-plan.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/decisions.md`
- `src/core/schemas/workflow.ts`
- `src/core/schemas/enums.ts`
- `src/core/state/machine.ts`

## Write Ownership

You may edit only these source areas:

- `src/core/schemas/enums.ts`
- `src/core/schemas/workflow.ts`
- `src/core/schemas/recovery.ts` if you create it
- `src/core/state/machine.ts`
- `src/core/state/selectors.ts` only if needed for recovery selectors
- `src/core/state/persistence.ts` only if migration/defaulting is needed
- tests colocated with the files above

Do not edit orchestrator or TUI files in this brief. If a type needs to be consumed there, expose it cleanly and leave wiring for later briefs.

## Required Behavior

- Define `RecoveryReason`, `RecoveryAction`, and `RecoveryIssue`.
- Add optional pending recovery state to workflow state with backwards-compatible parsing.
- Add state-machine transitions or actions to set, pause, apply, clear, and resolve pending recovery.
- Add event payload types if they belong with the durable schema.
- Ensure old `state.json` files parse without recovery fields.
- Ensure new `state.json` files persist and reload pending recovery.
- Keep the workflow phase as the execution location unless implementation proves a dedicated recovery phase is safer.

## Action Semantics To Support

Prepare schema support for these actions without implementing handlers:

- `retry-same-worker`
- `route-bigger-worker`
- `planner-split-rebase`
- `continue`
- `skip-current-task`
- `pause-run`
- `abort-workflow`

## Constraints

- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert other agents' edits.
- Node 22+.
- TypeScript ESM imports must use `.js` suffixes.
- Zero classes.
- No barrel files.
- Do not add `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Core schema and state code must not import React, Ink, `src/features/`, `src/components/`, or `src/hooks/`.
- Tests must verify behavior and artifacts, not private helper call order; avoid trivial hook tests.

## Non-Goals

- No kanban.
- No plan archive.
- No MCP write tools.
- No multi-agent manager.
- No same-checkout parallel writes.
- No full-screen TUI redesign.

## Validation Commands

Run targeted tests relevant to files you touched, then:

```bash
npm run typecheck
npm run lint
```

If you add recovery schema/state tests, run them explicitly, for example:

```bash
npm test -- src/core/schemas/recovery.test.ts src/core/state/machine.test.ts
```

## Expected Final Report

Report:

- files changed,
- recovery schema/state behavior implemented,
- tests run and results,
- skipped validation and why,
- risks or remaining work for issue builders, orchestrator wiring, actions, TUI, or validation briefs,
- confirmation that no staging, commits, or stash operations were run.
