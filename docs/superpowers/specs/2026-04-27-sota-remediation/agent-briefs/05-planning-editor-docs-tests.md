# 05 - Planning, Editor, Docs, Tests

> Implement only this brief after briefs 01-04 settle. Never stage, commit, or stash.

## Goal

Close remaining planning/editor/docs/test-policy gaps and make public documentation match final behavior.

## File Ownership

- `src/engine/orchestrator/planning/*`
- `src/engine/spec/prompts/*`
- `src/features/workflow/components/plan-editor/*`
- `src/features/workflow/hooks/use-plan-editor-*`
- `src/stores/workflow/plan-editor.ts`
- `src/features/workflow/components/command-palette-overlay.tsx`
- `src/core/config/load/*` only if optional config preservation is still missing
- docs under `docs/`
- behavior-test cleanup files

## Required Changes

1. Preserve optional config sections if not already fixed:
   - Load and write/transform paths preserve `codebase`, `hooks`, `otel`, `snapshots`, `palette`, and `approval`.
   - Add round-trip tests.

2. Command palette custom actions:
   - Ensure `palette.customActions` loaded from config appears in the command palette and executes configured slash command.
   - Keep tests behavior-based: rendered item, action result, overlay/store effect.

3. Plan editor correctness:
   - No-op boundary edits must not set `dirty: true`.
   - Successful edits clear stale save errors.
   - Merge/delete must relink downstream dependencies and avoid self-dependencies.
   - Save parse errors must set editor error instead of throwing.
   - Save validation must compare task ID sets, not index/order.
   - Non-zero external editor exit must not read/apply temp file.

4. Planning prompt contracts:
   - Instant/quick prompts must not weaken Task Brief v1 requirements around scope, validation, evidence, and escalation.
   - Invalid briefs must not enter implementation in any mode.
   - Review approval must validate persisted `tasks.md`, not stale memory.

5. Docs corrections:
   - Approval CLI docs: use final flag/path names from code.
   - Action class docs: use `package_change` if schema keeps that name.
   - MCP docs: describe final transport/resources exactly.
   - Handoff docs: renderer dir and `content` property.
   - Cost docs: describe final mounted status/drilldown components.
   - Snapshot/worktree docs: include `.trees/` exclusion and final start/worktree behavior.
   - Brief hash docs: do not claim `Task`/`state.json` task objects carry `briefHash` unless they actually do.

6. Test policy cleanup:
   - Replace new internal-module overmocking/call-count tests where feasible with behavior tests.
   - Known candidates: `start.test.ts`, `worktree.test.ts`, `detach.test.ts`, handoff writer tests, command palette tests, `use-app-keys.test.tsx`.
   - Keep sanctioned boundary mocks for process, filesystem failure, network, timers, Ink where necessary.

## Acceptance Criteria

- Config custom actions work in a real loaded config path.
- Plan editor public actions are coherent and safe.
- Invalid briefs are hard-blocked.
- Docs contain no known false claims from `AUDIT-FINDINGS.md`.
- Behavior tests cover the fixed public contracts.

## Tests

Run:

```bash
npm test -- src/core/config src/engine/orchestrator/planning src/engine/spec/prompts src/features/workflow/components/plan-editor src/features/workflow/hooks src/features/workflow/components/command-palette-overlay.test.tsx src/hooks/use-app-keys.test.tsx
npm run typecheck
npm run lint
```

