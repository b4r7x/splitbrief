# P4: approval.allowedPaths — Config-Level Persistent Path Allowlist

**Date:** 2026-04-30
**Status:** Implementation-ready
**Priority:** P4
**Dependencies:** None (additive to existing approval system)

## Problem

Users must configure `task.scope.inBounds` per-task to auto-approve writes to known-safe directories. This is per-Task-Brief and resets every run. Users who always want `src/**` and `tests/**` auto-approved must rely on sticky grants accumulating over time or accept repeated prompts.

Claude Code solves this with `settings.json` path-level permissions that persist across sessions. Diptych has no equivalent.

## Solution

Add `approval.allowedPaths` to the config schema — a persistent glob array that auto-approves writes to matching paths, independent of Task Brief scope.

```yaml
# .diptych/config.yaml
approval:
  enabled: true
  allowedPaths:
    - 'src/**'
    - 'tests/**'
    - 'docs/**'
```

Writes to files matching any `allowedPaths` glob are classified as `write_in_scope` (tier: `auto`) even when the file is outside the current task's `inBounds`.

## Design decisions

**D1: Union semantics.** A file is in-scope if it matches `task.inBounds` OR `config.approval.allowedPaths`. Either match is sufficient. This avoids a confusing precedence hierarchy — allowedPaths widens scope, never narrows it.

**D2: Reuse `matchesGlob()`.** The existing glob matcher in `action-classifier.ts` supports `src/**`, `src/*`, `*.ts`, and simple `*` wildcards. No new dependencies needed.

**D3: `classifyAction` input change.** Add `allowedPaths: string[]` to `ClassifyInput`. The alternative — passing the full `Config` — would break the classifier's current independence from the config schema. A flat `string[]` keeps the classifier pure and testable.

**D4: No config version bump.** `allowedPaths` is an optional field on an optional object. Existing configs without it parse identically. No migration needed.

**D5: Order-independent with tier overrides.** `allowedPaths` affects classification (action class), not tier assignment. If the user overrides `write_in_scope: 'sticky'` via `approval.tiers`, writes to allowed paths still get `write_in_scope` class but with the overridden tier. This is correct — the user explicitly chose to gate in-scope writes.

---

## Changes

### 1. Schema: `src/core/schemas/config.ts`

Add `allowedPaths` to `ApprovalConfigSchema`.

**Current code (lines 64–69):**

```ts
export const ApprovalConfigSchema = z.object({
  enabled: z.boolean().default(true),
  headless: z.boolean().optional(),
  tiers: TierMapSchema.optional(),
  feedRejectionsToPlanner: z.boolean().default(true),
});
```

**New code:**

```ts
export const ApprovalConfigSchema = z.object({
  enabled: z.boolean().default(true),
  headless: z.boolean().optional(),
  tiers: TierMapSchema.optional(),
  feedRejectionsToPlanner: z.boolean().default(true),
  allowedPaths: z.array(z.string().min(1)).optional(),
});
```

No other schema changes. The `Config` type infers the new field automatically via `z.infer`.

---

### 2. Classifier: `src/engine/orchestrator/action-classifier.ts`

#### 2a. Add `allowedPaths` to `ClassifyInput`

**Current code (lines 7–13):**

```ts
export type ClassifyInput = {
  actionDescription: string;
  taskFile: string;
  taskInBounds: string[];
  dependsOnFiles: string[];
  projectDir: string;
};
```

**New code:**

```ts
export type ClassifyInput = {
  actionDescription: string;
  taskFile: string;
  taskInBounds: string[];
  dependsOnFiles: string[];
  projectDir: string;
  allowedPaths?: string[] | undefined;
};
```

#### 2b. Update `isInScope()` to check `allowedPaths`

**Current code (lines 220–225):**

```ts
function isInScope(filePath: string, input: ClassifyInput): boolean {
  const normalized = normalizeProjectPath(filePath, input.projectDir);
  if (normalized === normalizeProjectPath(input.taskFile, input.projectDir)) return true;
  if (input.dependsOnFiles.map((file) => normalizeProjectPath(file, input.projectDir)).includes(normalized)) return true;
  return input.taskInBounds.some((glob) => matchesGlob(normalized, normalizeProjectPath(glob, input.projectDir)));
}
```

**New code:**

```ts
function isInScope(filePath: string, input: ClassifyInput): boolean {
  const normalized = normalizeProjectPath(filePath, input.projectDir);
  if (normalized === normalizeProjectPath(input.taskFile, input.projectDir)) return true;
  if (input.dependsOnFiles.map((file) => normalizeProjectPath(file, input.projectDir)).includes(normalized)) return true;
  if (input.taskInBounds.some((glob) => matchesGlob(normalized, normalizeProjectPath(glob, input.projectDir)))) return true;
  if (input.allowedPaths?.some((glob) => matchesGlob(normalized, glob))) return true;
  return false;
}
```

Key detail: `allowedPaths` globs are NOT run through `normalizeProjectPath` — they are config-level values already in project-relative form (`src/**`), not absolute paths. `taskInBounds` patterns come from task scope and may include absolute paths from the project dir, so they need normalization. `allowedPaths` are written by the user in the config as relative globs.

No other changes to `classifyAction()` or any other function in this file. The write-verb branch already calls `isInScope(targetPath, input)` at line 276 — the new `allowedPaths` check is picked up automatically.

---

### 3. Call site: `src/engine/orchestrator/tiered-approval.ts`

#### 3a. Pass `allowedPaths` through to `classifyAction`

**Current code (lines 297–305):**

```ts
  const { actionClass, tier } = classifyAction(
    {
      actionDescription,
      taskFile: task.file,
      taskInBounds: taskScopePatterns(task),
      dependsOnFiles,
      projectDir,
    },
    tierOverrides,
  );
```

**New code:**

```ts
  const { actionClass, tier } = classifyAction(
    {
      actionDescription,
      taskFile: task.file,
      taskInBounds: taskScopePatterns(task),
      dependsOnFiles,
      projectDir,
      allowedPaths: config.approval?.allowedPaths,
    },
    tierOverrides,
  );
```

That's the only call site change. `gateChangedFiles` calls `gateAction` which flows through the same path.

---

### 4. Tests: `src/engine/orchestrator/action-classifier.test.ts`

Add a new `describe` block at the end of the file:

```ts
describe('classifyAction — allowedPaths', () => {
  it('write to file matching allowedPaths → write_in_scope/auto', () => {
    const result = classifyAction(make('edit src/components/button.ts', {
      taskInBounds: ['src/feature/**'],
      allowedPaths: ['src/**'],
    }));
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('write to file NOT matching allowedPaths → write_out_of_scope/sticky', () => {
    const result = classifyAction(make('edit scripts/deploy.sh', {
      taskInBounds: ['src/feature/**'],
      allowedPaths: ['src/**'],
    }));
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('no allowedPaths → existing behavior unchanged', () => {
    const result = classifyAction(make('edit src/unrelated/other.ts'));
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('allowedPaths undefined → existing behavior unchanged', () => {
    const result = classifyAction(make('edit src/unrelated/other.ts', {
      allowedPaths: undefined,
    }));
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('allowedPaths empty array → existing behavior unchanged', () => {
    const result = classifyAction(make('edit src/unrelated/other.ts', {
      allowedPaths: [],
    }));
    expect(result).toEqual({ actionClass: 'write_out_of_scope', tier: 'sticky' });
  });

  it('allowedPaths + taskInBounds union: either match = in-scope', () => {
    const result = classifyAction(make('edit tests/unit/foo.test.ts', {
      taskInBounds: ['src/feature/**'],
      allowedPaths: ['tests/**'],
    }));
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('allowedPaths with extension wildcard', () => {
    const result = classifyAction(make('create docs/guide.md', {
      taskInBounds: ['src/**'],
      allowedPaths: ['*.md'],
    }));
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'auto' });
  });

  it('allowedPaths respects tier overrides on write_in_scope', () => {
    const result = classifyAction(
      make('edit src/components/button.ts', {
        taskInBounds: [],
        allowedPaths: ['src/**'],
      }),
      { write_in_scope: 'sticky' },
    );
    expect(result).toEqual({ actionClass: 'write_in_scope', tier: 'sticky' });
  });

  it('destructive action in allowed path still classified as destructive', () => {
    const result = classifyAction(make('rm -rf src/old/', {
      allowedPaths: ['src/**'],
    }));
    expect(result).toEqual({ actionClass: 'destructive', tier: 'confirm' });
  });
});
```

The `make()` helper in the existing test file already accepts `Partial<ClassifyInput>`, so `allowedPaths` flows through without changes to the test helper.

---

### 5. Config validation

No changes to `src/core/config/load/validate.ts`. The Zod schema handles validation — `z.array(z.string().min(1)).optional()` rejects empty strings in the array. No semantic validation is needed beyond what Zod provides (glob pattern validity is best-effort, like `taskInBounds`).

---

### 6. Config migration

**No version bump needed.** The field is optional on an optional object. Existing `version: 2` and `version: 3` configs parse identically with or without `allowedPaths`. The migration system in `src/core/config/load/migrate.ts` does not need a new step.

---

### 7. Documentation: `docs/CONFIGURATION.md`

Add to the `approval` section:

```markdown
### approval.allowedPaths

Type: `string[]` (optional)
Default: not set (no paths pre-approved)

Glob patterns for paths that are always treated as in-scope for writes. Writes to matching files are classified as `write_in_scope` (auto-approved by default) regardless of the current task's `inBounds`.

```yaml
approval:
  allowedPaths:
    - 'src/**'        # all files under src/
    - 'tests/**'      # all files under tests/
    - '*.md'          # all markdown files at any depth
```

This is a **union** with task-level `scope.inBounds` — either match is sufficient for in-scope classification. `allowedPaths` widens scope, never narrows it.

Supported glob patterns: exact match (`src/config.ts`), recursive directory (`src/**`), single-level directory (`src/*`), extension wildcard (`*.ts`), and simple star (`src/utils/*`).

Note: `allowedPaths` only affects the action *class* (`write_in_scope` vs `write_out_of_scope`), not the *tier*. If you override `approval.tiers.write_in_scope: 'sticky'`, writes to allowed paths will still prompt once per session.
```

---

## Files changed (summary)

| File | Change |
|---|---|
| `src/core/schemas/config.ts` | Add `allowedPaths` to `ApprovalConfigSchema` |
| `src/engine/orchestrator/action-classifier.ts` | Add `allowedPaths` to `ClassifyInput`, add check in `isInScope()` |
| `src/engine/orchestrator/tiered-approval.ts` | Pass `config.approval?.allowedPaths` to `classifyAction` input |
| `src/engine/orchestrator/action-classifier.test.ts` | Add 9 test cases for `allowedPaths` behavior |
| `docs/CONFIGURATION.md` | Document `approval.allowedPaths` |

---

## Acceptance criteria

1. `classifyAction({ ..., allowedPaths: ['src/**'] })` with write to `src/anything.ts` returns `{ actionClass: 'write_in_scope', tier: 'auto' }`.
2. Same input with write to `scripts/deploy.sh` returns `{ actionClass: 'write_out_of_scope', tier: 'sticky' }`.
3. Omitting `allowedPaths` or passing `undefined` / `[]` produces identical behavior to current codebase.
4. `allowedPaths` and `taskInBounds` are unioned — either match = in-scope.
5. Destructive/network/package patterns still take precedence over write classification (priority order unchanged).
6. Tier overrides on `write_in_scope` are respected (allowedPaths doesn't bypass tier overrides).
7. `npm run test-ci` passes (typecheck + lint + 3392+ tests).
8. No config migration step needed — existing configs unaffected.
