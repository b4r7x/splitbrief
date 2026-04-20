# Brief 07 — Git modes exposed in `/settings`, add `createBranch`

> **You are a fresh AI context.** Read `../spec.md` §4.8 and `../decisions.md` ADR-009 before starting. Do NOT commit (see `../../../../CLAUDE.md`).

## Goal

Expose the existing `commitStrategy` and a new `createBranch: boolean` in the `/settings` overlay. When `createBranch: true`, the orchestrator runs `git checkout -b diptych/<slug>` at workflow start. Footer shows `[git: per-task]` / `[git: checkpoint]` / `[git: none]`.

## Dependencies

- Brief 01 complete (v3 schema has `workflow.git` subtree).

## Files to touch

Write-authoritative:

- `src/core/schemas/config.ts` (already adjusted in brief 01; verify)
- `src/core/settings/catalog.ts`
- `src/lib/git.ts`
- `src/lib/git.test.ts`
- `src/engine/orchestrator/setup.ts` (or wherever workflow setup lives — search `setupWorkflow`)
- `src/cli/setup.ts`
- `src/features/workflow/components/input-footer.tsx`
- `src/engine/orchestrator/task-commit.ts`
- `src/utils/slug.ts` (NEW, if not already present — search `slug` first)
- `docs/CONFIG.md`
- `docs/WORKFLOW.md`

## Step-by-step

### 1. Slug helper

File: `src/utils/slug.ts` (NEW — check if one exists first; if the session-id generator already slugs, refactor that one to expose it)

```ts
/** kebab-case, alphanumeric + hyphen only, collapsed, no leading/trailing hyphens. Max 40 chars. */
export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
```

Colocated test with 5 cases (empty, unicode, leading/trailing hyphens, long input, mixed case).

### 2. Git helpers

File: `src/lib/git.ts`

Add at the end:

```ts
/** Return true if the branch exists locally. */
export async function branchExists(dir: string, name: string): Promise<boolean> {
  const g = simpleGit(dir);
  const branches = await g.branchLocal();
  return branches.all.includes(name);
}

/**
 * Create a new branch based on HEAD.
 * If `name` already exists, appends `-2`, `-3`, ... until unique.
 * Returns the final branch name used.
 */
export async function createBranch(dir: string, desiredName: string): Promise<string> {
  const g = simpleGit(dir);
  let name = desiredName;
  let suffix = 2;
  while (await branchExists(dir, name)) {
    name = `${desiredName}-${suffix}`;
    suffix++;
    if (suffix > 99) throw new Error(`too many branch name collisions on ${desiredName}`);
  }
  await g.checkoutLocalBranch(name);
  return name;
}
```

Tests in `git.test.ts`:

```ts
describe('createBranch', () => {
  it('creates a new branch', async () => {
    const dir = await createTestGitRepo();
    const name = await createBranch(dir, 'diptych/foo');
    expect(name).toBe('diptych/foo');
    const g = simpleGit(dir);
    const status = await g.status();
    expect(status.current).toBe('diptych/foo');
  });
  it('appends -2 on collision', async () => {
    const dir = await createTestGitRepo();
    await createBranch(dir, 'diptych/foo');
    // switch back:
    await simpleGit(dir).checkout('main');
    const name = await createBranch(dir, 'diptych/foo');
    expect(name).toBe('diptych/foo-2');
  });
  it('throws after 99 collisions', async () => {
    // stress-test synthetically; skip in slow tests
  });
});
```

### 3. Workflow startup hook

File: `src/engine/orchestrator/setup.ts` (search for the function that runs at workflow start before planning — if it's inside `runWorkflow`, carve out a helper)

Before any planner call, if `config.workflow.git.createBranch === true`:

```ts
if (config.workflow.git.createBranch) {
  const desired = `diptych/${slug(feature)}`;
  try {
    const actual = await createBranch(projectDir, desired);
    bus.publish({
      type: 'git_branch_created',
      phase: 'idle',
      ts: Date.now(),
      name: actual,
    });
  } catch (err) {
    bus.publish({
      type: 'warning',
      phase: 'idle',
      ts: Date.now(),
      message: `failed to create branch: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
```

Add the event variant:

File: `src/engine/events/types.ts`

```ts
| { type: 'git_branch_created'; phase: Phase; ts: number; name: string }
```

Renderer in `event-card.tsx`:

```tsx
case 'git_branch_created':
  return <Text color={theme.success}>branch: {event.name}</Text>;
```

### 4. Settings catalog entries

File: `src/core/settings/catalog.ts`

```ts
{
  id: 'workflow.git.commitStrategy',
  label: 'Commit strategy',
  section: 'workflow',
  description: 'per-task: one commit per passing task. checkpoint: stash-based snapshots. none: no commits.',
  kind: 'enum',
  values: ['per-task', 'checkpoint', 'none'],
  readValue: (config) => config.workflow.git.commitStrategy,
  writeValue: (config, value) => {
    config.workflow.git.commitStrategy = value;
    return config;
  },
},
{
  id: 'workflow.git.createBranch',
  label: 'Create feature branch',
  section: 'workflow',
  description: 'Create a diptych/<feature-slug> branch at workflow start.',
  kind: 'boolean',
  readValue: (config) => config.workflow.git.createBranch,
  writeValue: (config, value) => {
    config.workflow.git.createBranch = value;
    return config;
  },
},
```

Remove any obsolete `workflow.commitStrategy` entries (pre-v3 location).

### 5. task-commit.ts audit

File: `src/engine/orchestrator/task-commit.ts`

The explore-report §2 showed `validateCommitAndAdvance` reads `config.workflow.commitStrategy`. After brief 01's migration, the field moved to `config.workflow.git.commitStrategy`. Update every read:

```ts
// Before:
const strategy = config.workflow.commitStrategy;
// After:
const strategy = config.workflow.git.commitStrategy;
```

There are 1–3 reads per explore-report. Change them all. `rg 'workflow\.commitStrategy' src/` should return zero results after this step.

### 6. cli/setup.ts check

File: `src/cli/setup.ts`

The existing `assertGitRepo` (line 24-28) still applies. No change needed; `createBranch` requires a git repo.

### 7. Footer badge

File: `src/features/workflow/components/input-footer.tsx`

Add after the existing task counter:

```tsx
const git = configStore.useConfig().workflow.git;
const gitLabel = git.createBranch
  ? `git: branch+${git.commitStrategy}`
  : `git: ${git.commitStrategy}`;

// in the right-side Box:
<Text color={t.muted}>[{gitLabel}]</Text>
```

### 8. Doc updates

File: `docs/CONFIG.md`

Under `workflow.git`:

```md
- `workflow.git.commitStrategy` — `'per-task' | 'checkpoint' | 'none'`. Default: `'none'`. Per-task commits after each passing task; checkpoint creates a git stash at start; none does nothing. Legacy key `workflow.commitStrategy` is accepted on input for one release.
- `workflow.git.createBranch` — boolean, default `false`. When true, `diptych start` runs `git checkout -b diptych/<slug>` before planning. Suffixes `-2`, `-3`, ... are appended on collision.
```

File: `docs/WORKFLOW.md`

Under §1.4 (persistence timing) add:

```md
| `git checkout -b diptych/<slug>` | git branches | `start` when `workflow.git.createBranch: true` | Branch persisted in git (not under `.diptych/`) |
```

### 9. Tests

Add to integration tests (e.g., `src/engine/orchestrator/run/run.integration.test.ts`):

```ts
describe('createBranch startup', () => {
  it('creates diptych/<slug> branch when enabled', async () => {
    const ctx = createTestWorkflowContext({
      config: { workflow: { git: { createBranch: true, commitStrategy: 'none' } } },
      feature: 'add auth',
    });
    await runWorkflow(ctx);
    const g = simpleGit(ctx.projectDir);
    const status = await g.status();
    expect(status.current).toBe('diptych/add-auth');
  });

  it('suffixes on existing branch', async () => {
    const ctx = createTestWorkflowContext({
      config: { workflow: { git: { createBranch: true, commitStrategy: 'none' } } },
      feature: 'add auth',
    });
    const g = simpleGit(ctx.projectDir);
    await g.checkoutLocalBranch('diptych/add-auth');
    await g.checkout('main');

    await runWorkflow(ctx);
    const status = await g.status();
    expect(status.current).toBe('diptych/add-auth-2');
  });
});
```

### 10. Verification gate

```bash
npm run typecheck
npm run lint
npm test
```

## Rollback

Revert listed files. Delete the `createBranch` / `branchExists` helpers from `git.ts`. Restore `commitStrategy` reads to the pre-move location if brief 01 hasn't landed.

## Checkpoint

- `/settings` shows `Commit strategy` and `Create feature branch` toggles.
- Footer shows `[git: <strategy>]`.
- `createBranch: true` creates the branch at start; collision gets a suffix.
- All existing commit-strategy tests pass (they already cover `per-task` / `checkpoint` / `none`).
