# 01 — Action Classifier

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

Agent: Action Classifier implementer
Brief: 01 of 06 (Tiered Approval Gates spec)

## Intent

Create a pure, deterministic classifier that maps an implementer action description to one of three approval tiers. No I/O. No side effects. Fully testable with fixture cases.

## Scope

**In bounds:**
- `src/engine/orchestrator/action-classifier.ts` (new file)
- `src/engine/orchestrator/action-classifier.test.ts` (new file)
- `src/core/paths.ts` — add `APPROVALS_FILE` constant (project-level artifact)

**Out of bounds:**
- Do not modify `src/engine/orchestrator/approval.ts` (document-level loop — untouched).
- Do not modify `src/engine/hooks/` (the gate engine in brief 02 integrates with hooks; the classifier is standalone).
- Do not modify config schema (brief 03 owns that).
- Do not add I/O, logging, or event emission.

## Code Context

Read before implementing:

- `src/core/schemas/task.ts` — `Task`, `TaskId`, `task.file`, `task.scope.inBounds`
- `src/core/paths.ts` — existing constants pattern; add `APPROVALS_FILE`
- `src/engine/orchestrator/types.ts` — `WorkflowContext` shape for reference

## Implementation Plan

### 1. Add `APPROVALS_FILE` to `src/core/paths.ts`

```ts
export const APPROVALS_FILE = 'approvals.json';
```

This file lives at `.diptych/approvals.json` (project root level, not under sessions).

### 2. Define types in `src/engine/orchestrator/action-classifier.ts`

Import `ActionClass` and `ActionClassSchema` from the canonical schema location:

```ts
import type { ActionClass } from '../../core/schemas/approval-store.js';
```

`ActionClass` and `ApprovalTier` are owned by `src/core/schemas/approval-store.ts` (brief 03). Do not redefine them here. Export your own classifier-specific types only:

```ts
export type ApprovalTier = 'auto' | 'sticky' | 'confirm';

export type TierMap = Partial<Record<ActionClass, ApprovalTier>>;

export type ClassifyInput = {
  actionDescription: string;  // raw string from implementer tool call
  taskFile: string;           // task.file (project-relative)
  taskInBounds: string[];     // task.scope.inBounds ?? []
  dependsOnFiles: string[];   // project-relative files from dependsOn tasks
  projectDir: string;
};

export type ClassifyResult = {
  actionClass: ActionClass;
  tier: ApprovalTier;
};
```

### 3. Implement `classifyAction`

```ts
export function classifyAction(
  input: ClassifyInput,
  tierOverrides?: TierMap,
): ClassifyResult
```

Classification logic (apply in order; first match wins):

1. **destructive** — description contains any of: `rm -rf`, `rm -r`, `git reset --hard`, `git clean -f`, `git push --force`, `git push -f`, `git branch -D`. Tier: `confirm`.
2. **network** — description contains any of: `curl `, `wget `, `fetch(`, `npm publish`, `http://`, `https://`, external domain patterns (`*.com`, `*.io` etc in URLs outside localhost). Tier: `confirm`.
3. **package_change** — description contains any of: `npm install`, `npm uninstall`, `npm i `, `pip install`, `pip uninstall`, `yarn add`, `yarn remove`, `pnpm add`, `pnpm remove`. Tier: `confirm`.
4. **validation** — description contains any of: `tsc`, `eslint`, `biome check`, `vitest`, `npm test`, `npm run test`, `npm run typecheck`, `npm run lint`. Tier: `auto`.
5. **read** — description starts with `read `, `cat `, `ls `, `find `, `grep ` (case-insensitive). Tier: `auto`.
6. **write_in_scope** — description contains a write verb (`write`, `create`, `edit`, `patch`, `apply diff`) AND the target path is in scope (see scope logic below). Tier: `auto`.
7. **write_out_of_scope** — any remaining write. Tier: `sticky`.

**Scope logic** (for step 6): a target path is in scope if:
- It equals `taskFile`, OR
- It is in `dependsOnFiles`, OR
- It matches any glob in `taskInBounds` (use micromatch), OR
- (fall-through) target path is not determinable from description → classify as `write_out_of_scope`.

To extract the target path from `actionDescription`: look for the first project-relative-looking path token (starts with `src/`, `test`, `docs/`, or `./`). If none found, treat as out-of-scope for write verbs.

**Tier overrides:** after determining `actionClass`, look up `tierOverrides[actionClass]`. If present, use that tier instead of the default.

Note: `ApprovalTier` is defined locally in `action-classifier.ts` for now because `approval-store.ts` (brief 03) may not yet exist when this brief runs. If brief 03 is already merged, import `ApprovalTier` from `'../../core/schemas/approval-store.js'` instead.

### 4. Export a default tier map

```ts
export const DEFAULT_TIER_MAP: Record<ActionClass, ApprovalTier> = {
  read: 'auto',
  write_in_scope: 'auto',
  validation: 'auto',
  write_out_of_scope: 'sticky',
  destructive: 'confirm',
  network: 'confirm',
  package_change: 'confirm',
};
```

## Validation

### Tests (`src/engine/orchestrator/action-classifier.test.ts`)

Cover at minimum:

- `rm -rf dist/` → `destructive` / `confirm`
- `git reset --hard HEAD` → `destructive` / `confirm`
- `git push --force origin main` → `destructive` / `confirm`
- `npm install lodash` → `package_change` / `confirm`
- `npm publish` → `network` / `confirm`
- `curl https://api.example.com/data` → `network` / `confirm`
- `npm run tsc` → `validation` / `auto`
- `npm run typecheck` → `validation` / `auto`
- `read src/core/paths.ts` → `read` / `auto`
- write to `task.file` → `write_in_scope` / `auto`
- write to file in `dependsOnFiles` → `write_in_scope` / `auto`
- write to file matching `task.scope.inBounds` glob → `write_in_scope` / `auto`
- write to `src/unrelated/other.ts` → `write_out_of_scope` / `sticky`
- write with no extractable path → `write_out_of_scope` / `sticky`
- tier override: `write_out_of_scope` → `confirm` via `tierOverrides`
- tier override: `package_change` → `sticky` via `tierOverrides`
- order: `npm install` is `package_change` even if description also mentions a file write

## Constraints

- No imports from `ink`, `react`, or any `src/features/` / `src/components/` path.
- No I/O (no `fs`, no `path.resolve` for file existence checks — classify from string only).
- `micromatch` import: `import micromatch from 'micromatch'` (already a transitive dep).
- All pattern matching is case-insensitive substring or prefix matching. No regex required.
- The function must be synchronous.

## Escalation

If the description never matches a write verb and no destructive/network/package patterns match, classify as `read` to avoid false positives.

If `micromatch` is not available as a transitive dep, use simple `String.includes` / `String.startsWith` for `inBounds` matching and note the limitation in a comment.

## Evidence Requirements

- New file: `src/engine/orchestrator/action-classifier.ts`
- New file: `src/engine/orchestrator/action-classifier.test.ts`
- Modified: `src/core/paths.ts` (add `APPROVALS_FILE`)
- All tests pass: `npm test -- src/engine/orchestrator/action-classifier.test.ts`
- Typecheck clean: `npm run typecheck`
