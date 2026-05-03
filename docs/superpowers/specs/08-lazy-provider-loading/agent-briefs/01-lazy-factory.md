# 01 - Lazy Factory

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Replace static imports with memoized `??=` dynamic imports. Make `createPlanner` and `createImplementer` async. Update all callers.

## Required Skills

- `/test-behavior-not-implementation`
- `/clean-code`

## Write Ownership

```
src/engine/runners/factory.ts       (rewrite)
src/engine/runners/factory.test.ts  (create or extend)
```

Plus all callers of `createPlanner(` and `createImplementer(` — grep the codebase.

## Required Behavior

### Memoized lazy imports

```typescript
// src/engine/runners/factory.ts
let _claudeCode: Promise<typeof import('../planners/claude-code.js')> | undefined;
function loadClaudeCodePlanner() {
  return (_claudeCode ??= import('../planners/claude-code.js'));
}

let _cliPlanner: Promise<typeof import('../planners/cli.js')> | undefined;
function loadCliPlanner() {
  return (_cliPlanner ??= import('../planners/cli.js'));
}

// ... same pattern for all 11 modules
```

### Async factory functions

```typescript
export async function createPlanner(config: Config): Promise<Planner> {
  const kind = config.planner.kind;
  switch (kind) {
    case 'cli': {
      if (config.planner.tool === 'claude-code') {
        const mod = await loadClaudeCodePlanner();
        return mod.createClaudeCodePlanner(config);
      }
      const mod = await loadCliPlanner();
      return mod.createCliPlanner(config);
    }
    case 'api': {
      const mod = await loadApiPlanner();
      return mod.createApiPlanner(config);
    }
    case 'shell': {
      const mod = await loadShellPlanner();
      return mod.createShellPlanner(config);
    }
    case 'agent': {
      const mod = await loadAgentPlanner();
      return mod.createAgentPlanner(config);
    }
    case 'agent-sdk': {
      try {
        const mod = await loadAgentSdkPlanner();
        return mod.createAgentSdkPlanner(config);
      } catch {
        throw new Error(
          'agent-sdk runner requires @anthropic-ai/claude-agent-sdk — install it with: npm install @anthropic-ai/claude-agent-sdk'
        );
      }
    }
  }
}

export async function createImplementer(config: Config): Promise<Implementer> {
  // Same pattern for implementer kinds
}
```

### Update callers

Grep for `createPlanner(` and `createImplementer(` across the entire codebase. Add `await` at each call site. Key locations likely include:
- `src/engine/orchestrator/` — workflow initialization
- `src/engine/orchestrator/escalation/tier0-intermediate.ts`
- Test files

Remove the `PLANNER_FACTORIES` and `IMPLEMENTER_FACTORIES` lookup tables — they're replaced by the switch.

## TDD Steps

- [ ] **Write test: factory creates planner for each kind**

```typescript
// src/engine/runners/factory.test.ts
import { describe, it, expect } from 'vitest';
import { createPlanner, createImplementer } from './factory.js';

describe('createPlanner (lazy)', () => {
  it('creates CLI planner', async () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });
    const planner = await createPlanner(config);
    expect(planner).toBeTruthy();
    expect(planner.plan).toBeTypeOf('function');
  });

  it('creates API planner', async () => {
    const config = makeConfig({ planner: { kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1' } });
    const planner = await createPlanner(config);
    expect(planner).toBeTruthy();
  });

  it('agent-sdk with missing package throws clear error', async () => {
    // Only test if agent-sdk is NOT installed
    const config = makeConfig({ planner: { kind: 'agent-sdk' } });
    await expect(createPlanner(config)).rejects.toThrow('agent-sdk');
  });

  it('calling createPlanner twice works (memoized module)', async () => {
    const config = makeConfig({ planner: { kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1' } });
    const p1 = await createPlanner(config);
    const p2 = await createPlanner(config);
    expect(p1).toBeTruthy();
    expect(p2).toBeTruthy();
  });
});
```

- [ ] **Run tests, implement, verify**
- [ ] **Grep and update ALL callers** — add await
- [ ] **Run:** `npm run test-ci`
- [ ] **Update docs:** ARCHITECTURE.md (runner factory section)

## Verification

- [ ] `createPlanner` and `createImplementer` are async
- [ ] All callers updated with await (no type errors)
- [ ] Only configured runner's module loads (temporarily add console.log to verify)
- [ ] agent-sdk missing → clear install instruction
- [ ] `npm run test-ci` passes
