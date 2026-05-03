# 01 - Hook Discovery + Module Polish

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Add auto-discovery of hook modules from `.diptych/hooks/`. Verify existing module execution works. Ensure timeout parity with command hooks. Add validation for module export contract.

## Required Skills

- `/test-behavior-not-implementation`
- `/clean-code`

## Write Ownership

```
src/engine/hooks/discover.ts        (create)
src/engine/hooks/discover.test.ts   (create)
src/engine/hooks/dispatch.test.ts   (create or extend)
src/engine/hooks/load-module.ts     (modify — add validation)
src/engine/hooks/load-module.test.ts (create)
```

Plus integration point where discovered hooks merge into config (likely in config loading or hook sink creation).

## Required Behavior

### Auto-discovery

```typescript
// src/engine/hooks/discover.ts
import { readdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import type { HookEvent } from '../../core/schemas/hooks.js';

const KEBAB_TO_SNAKE: Record<string, string> = {
  'pre-planning': 'pre_planning', 'post-planning': 'post_planning',
  'pre-task': 'pre_task', 'post-task': 'post_task',
  'pre-validation': 'pre_validation', 'post-validation': 'post_validation',
  'pre-commit': 'pre_commit', 'post-commit': 'post_commit',
  'pre-escalation': 'pre_escalation', 'pre-compact': 'pre_compact',
  'on-error': 'on_error', 'on-complete': 'on_complete',
};

export interface DiscoveredHook {
  event: string;
  path: string;
}

export async function discoverHookModules(projectDir: string): Promise<DiscoveredHook[]> {
  const hooksDir = join(projectDir, '.diptych', 'hooks');
  let entries: string[];
  try { entries = await readdir(hooksDir); } catch { return []; }

  const hooks: DiscoveredHook[] = [];
  for (const entry of entries) {
    const ext = extname(entry);
    if (ext !== '.ts' && ext !== '.js') continue;
    const name = basename(entry, ext);
    const event = KEBAB_TO_SNAKE[name];
    if (!event) continue;
    hooks.push({ event, path: join(hooksDir, entry) });
  }
  return hooks;
}
```

### Merge discovered hooks

In the hook sink creation path (or config resolution), merge discovered hooks with explicit config. Explicit config runs first, discovered hooks run after, for the same event.

### Module export validation

In `load-module.ts`, add checks:
```typescript
const mod = await import(pathToFileURL(absPath).href);
const fn = mod.default;
if (typeof fn !== 'function') {
  throw new Error(`Hook module ${absPath} must export a default function, got ${typeof fn}`);
}
```

### Timeout parity

Verify `runModuleHook` uses the same default timeout as command hooks. Check `HookEntrySchema` default for `timeout_ms`. If they differ, align them.

## TDD Steps

- [ ] **Write discovery test**

```typescript
// src/engine/hooks/discover.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverHookModules } from './discover.js';

describe('discoverHookModules', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hooks-'));
    mkdirSync(join(tmpDir, '.diptych', 'hooks'), { recursive: true });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true }));

  it('discovers pre-task.ts as pre_task event', async () => {
    writeFileSync(join(tmpDir, '.diptych', 'hooks', 'pre-task.ts'), 'export default () => ({ kind: "allow" })');
    const hooks = await discoverHookModules(tmpDir);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].event).toBe('pre_task');
  });

  it('discovers multiple hook files', async () => {
    writeFileSync(join(tmpDir, '.diptych', 'hooks', 'pre-task.ts'), '');
    writeFileSync(join(tmpDir, '.diptych', 'hooks', 'post-validation.js'), '');
    const hooks = await discoverHookModules(tmpDir);
    expect(hooks).toHaveLength(2);
  });

  it('ignores non-matching filenames', async () => {
    writeFileSync(join(tmpDir, '.diptych', 'hooks', 'readme.md'), '');
    writeFileSync(join(tmpDir, '.diptych', 'hooks', 'utils.ts'), '');
    const hooks = await discoverHookModules(tmpDir);
    expect(hooks).toHaveLength(0);
  });

  it('returns empty when hooks dir does not exist', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'no-hooks-'));
    const hooks = await discoverHookModules(emptyDir);
    expect(hooks).toHaveLength(0);
    rmSync(emptyDir, { recursive: true });
  });
});
```

- [ ] **Write module validation test**

```typescript
// src/engine/hooks/load-module.test.ts
it('throws when module has no default export', async () => {
  // Create temp .ts file that exports named, not default
  // Attempt to load → expect clear error message
});

it('throws when default export is not a function', async () => {
  // Create temp .ts file: export default "not a function"
  // Attempt to load → expect clear error about typeof
});
```

- [ ] **Run tests, implement, verify**
- [ ] **Run:** `npm run test-ci`
- [ ] **Update docs:** HOOKS-CONFIG.md (module hooks + discovery), FUTURE.md (mark done)

## Verification

- [ ] `.diptych/hooks/pre-task.ts` auto-registers as `pre_task` hook
- [ ] Non-matching filenames (readme.md, utils.ts) are ignored
- [ ] Missing `.diptych/hooks/` directory → empty discovery, no error
- [ ] Module hook returns deny → pre-hook blocks operation
- [ ] Module hook timeout → uses on_failure policy (parity with command hooks)
- [ ] Invalid module export → clear error message, not opaque crash
- [ ] Explicit config hooks run before discovered hooks for same event
- [ ] `npm run test-ci` passes
