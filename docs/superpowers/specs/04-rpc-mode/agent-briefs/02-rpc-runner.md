# 02 - RPC Runner + CLI Integration

> Implement only this brief. Do not run git add/commit/stage/stash.
> Depends on: brief 01 (types + reader/writer).

## Goal

Create the RPC workflow runner with promise-based approval gates. Add `--rpc` CLI flag. Route commands to workflow actions. Existing `--json` behavior unchanged.

## Required Skills

- `/test-behavior-not-implementation`
- `/clean-code`
- `/code-audit`

## Write Ownership

```
src/cli/rpc/run.ts          (create)
src/cli/rpc/run.test.ts     (create)
src/cli/rpc/gates.ts        (create)
src/cli/options.ts           (modify — add --rpc)
src/cli/commands/start.ts    (modify — route --rpc)
src/cli/commands/continue.ts (modify — route --rpc)
```

## Required Behavior

### gates.ts — Promise-based approval gates

```typescript
import type { RpcCommand } from './types.js';

export function createApprovalGate() {
  let resolve: ((result: { approved: boolean; comment?: string }) => void) | null = null;

  return {
    wait(): Promise<{ approved: boolean; comment?: string }> {
      return new Promise(r => { resolve = r; });
    },
    handle(cmd: RpcCommand): boolean {
      if (!resolve) return false;
      if (cmd.type === 'approve') { resolve({ approved: true }); resolve = null; return true; }
      if (cmd.type === 'reject') { resolve({ approved: false, comment: cmd.comment }); resolve = null; return true; }
      return false;
    },
    isPending(): boolean { return resolve !== null; },
  };
}
```

### run.ts — RPC workflow runner

Create `runRpc(opts)` that:
1. Creates reader (stdin), writer (stdout), approval gate
2. Subscribes to EventBus → forward all events via `writer.event()`
3. Calls `runWorkflow()` with callbacks that use the gate:
   - `onApprovalNeeded` → `writer.event({ type: 'approval_prompted', ... })` + `gate.wait()`
   - `onQuestionAsked` → emit event + wait for `message` command
   - `onBudgetExceeded` → emit event + wait for approve/reject
4. Command dispatch: on each command from reader:
   - `approve`/`reject` → `gate.handle(cmd)`
   - `message` → enqueue via existing ENQUEUE_USER_MSG
   - `recovery` → call `applyRecoveryAction()`
   - `status` → read state, write status response
   - `abort` → signal abort
   - `slash` → execute slash command with stub context
5. On workflow complete → close reader

Model this after `src/cli/headless.ts` but with blocking gates instead of auto-approve. Reference `src/engine/orchestrator/escalation/tier0-intermediate.ts` for how to create stubbed implementers in tests.

### CLI integration

In `src/cli/options.ts`:
```typescript
.option('--rpc', 'RPC mode: bidirectional NDJSON on stdin/stdout', false)
```

In `start.ts` and `continue.ts`: if `--rpc`, call `runRpc()` instead of `runHeadless()`.
`--rpc` and `--json` are mutually exclusive. `--rpc` implies headless behavior.

## TDD Steps

- [ ] **Write gate test**

```typescript
import { describe, it, expect } from 'vitest';
import { createApprovalGate } from './gates.js';

describe('createApprovalGate', () => {
  it('resolves on approve command', async () => {
    const gate = createApprovalGate();
    const promise = gate.wait();
    gate.handle({ type: 'approve' });
    const result = await promise;
    expect(result.approved).toBe(true);
  });

  it('resolves with comment on reject', async () => {
    const gate = createApprovalGate();
    const promise = gate.wait();
    gate.handle({ type: 'reject', comment: 'needs work' });
    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.comment).toBe('needs work');
  });

  it('ignores commands when not pending', () => {
    const gate = createApprovalGate();
    expect(gate.handle({ type: 'approve' })).toBe(false);
  });
});
```

- [ ] **Run tests, implement, verify**
- [ ] **Integration test: create stubbed planner, drive via RPC**
- [ ] **Run:** `npm run test-ci`
- [ ] **Update docs:** CLI-REFERENCE.md (--rpc flag), ARCHITECTURE.md (RPC section), FEATURES.md, USAGE-EXAMPLES.md

## Verification

- [ ] `--json` works exactly as before (auto-approve, output-only)
- [ ] `--rpc` blocks on approval gates until stdin commands arrive
- [ ] `status` command returns current state
- [ ] Malformed stdin → error response, no crash
- [ ] `--rpc` and `--json` are mutually exclusive
- [ ] `npm run test-ci` passes
