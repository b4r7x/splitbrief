# 01 - Unblock route-bigger-worker

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Remove the `route-bigger-not-ready` block. Wire `selectedImplementerProfile` from recovery issue into the retry step as a profile override. When user selects route-bigger-worker, the failed task retries with the bigger profile's implementer.

## Required Skills

- `/test-behavior-not-implementation`
- `/clean-code`
- `/code-audit`

## Write Ownership

```
src/engine/orchestrator/recovery/actions.ts           (modify — unblock)
src/engine/orchestrator/recovery/actions.test.ts      (create or extend)
src/engine/orchestrator/escalation/step.ts            (modify — add profileOverride)
src/engine/orchestrator/escalation/step.test.ts       (create or extend)
src/engine/orchestrator/recovery/builders/shared.ts   (verify hasRouteBigger)
```

## Required Behavior

### 1. Add profileOverride to runRetryStep

In `step.ts`, add `profileOverride?: string` to the retry step options. When set:

```typescript
// In runRetryStep, before creating the implementer:
const implementer = profileOverride
  ? await createImplementerForProfile(profileOverride, config)
  : defaultImplementer;
```

Create a helper (in same file or nearby):
```typescript
async function createImplementerForProfile(
  profileName: string,
  config: Config,
): Promise<Implementer> {
  const profiles = resolveImplementerProfiles(config);
  const profile = profiles.profiles.find(p => p.name === profileName);
  if (!profile) throw new Error(`Profile '${profileName}' not found`);
  return createImplementer({ ...config, implementer: profile.config });
}
```

Follow the pattern from `tier0-intermediate.ts` which already creates temporary implementers.

### 2. Unblock route-bigger-worker in actions.ts

Replace lines 105-117 (the block) with:

```typescript
case 'route-bigger-worker': {
  const profileName = issue.facts?.routeBiggerProfile as string | undefined;
  if (!profileName) {
    return { ok: false, status: 'blocked', code: 'missing-profile' as const,
      message: 'No bigger profile identified in recovery issue facts' };
  }
  const profiles = resolveImplementerProfiles(config);
  const target = profiles.profiles.find(p => p.name === profileName);
  if (!target) {
    return { ok: false, status: 'blocked', code: 'profile-not-found' as const,
      message: `Profile '${profileName}' not found in config` };
  }
  // Set the selected profile so the retry path picks it up
  issue.selectedImplementerProfile = profileName;
  return { ok: true, status: 'retry-current-task' };
}
```

### 3. Wire selectedImplementerProfile into retry path

In the orchestrator's main loop, when handling `retry-current-task` from recovery, read `state.pendingRecovery.selectedImplementerProfile` and pass it as `profileOverride` to `runRetryStep`.

### 4. Verify hasRouteBigger populates the profile name

In `builders/shared.ts`, `hasRouteBigger()` should check current profile's cost tier, find a cheaper tier available, and set `facts.routeBiggerProfile = nextProfile.name`. Read the code to verify this is already done. If it only returns a boolean, extend it to also identify the profile name.

### 5. Verify task_started event reports the profile

`task_started` already includes `implementerProfile`. Verify it reflects the overridden profile, not the default.

## TDD Steps

- [ ] **Write test: route-bigger-worker unblocked**

```typescript
// src/engine/orchestrator/recovery/actions.test.ts
import { describe, it, expect } from 'vitest';

describe('applyRecoveryAction: route-bigger-worker', () => {
  it('returns retry-current-task when bigger profile exists', async () => {
    const issue = createMockRecoveryIssue({
      availableActions: ['route-bigger-worker'],
      recommendedAction: 'route-bigger-worker',
      facts: { routeBiggerProfile: 'cloud-capable' },
    });
    const config = createMockConfig({
      implementerProfiles: {
        default: 'local-fast',
        profiles: {
          'local-fast': { kind: 'api', provider: 'ollama', model: 'qwen:7b', costTier: 'local' },
          'cloud-capable': { kind: 'api', provider: 'anthropic', model: 'sonnet', costTier: 'standard' },
        },
      },
    });
    const result = await applyRecoveryAction({
      issue, selectedAction: 'route-bigger-worker', config, /* ... */
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('retry-current-task');
    expect(issue.selectedImplementerProfile).toBe('cloud-capable');
  });

  it('blocks when routeBiggerProfile fact is missing', async () => {
    const issue = createMockRecoveryIssue({ facts: {} });
    const result = await applyRecoveryAction({
      issue, selectedAction: 'route-bigger-worker', /* ... */
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
  });

  it('blocks when named profile does not exist in config', async () => {
    const issue = createMockRecoveryIssue({ facts: { routeBiggerProfile: 'nonexistent' } });
    const result = await applyRecoveryAction({
      issue, selectedAction: 'route-bigger-worker', /* ... */
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Run tests, implement, verify**
- [ ] **Write test: profile override in retry step**

```typescript
// src/engine/orchestrator/escalation/step.test.ts
it('uses overridden profile implementer when profileOverride is set', async () => {
  // Mock createImplementer to capture the config it receives
  // Call runRetryStep with profileOverride: 'cloud-capable'
  // Verify createImplementer was called with the cloud-capable profile config
});
```

- [ ] **Run tests, implement, verify**
- [ ] **Run:** `npm run test-ci`
- [ ] **Update docs:** WORKFLOW.md, COST-AWARE-IMPLEMENTER-DIRECTION.md, CONFIGURATION.md, FEATURES.md

## Verification

- [ ] route-bigger-worker no longer returns blocked
- [ ] Task retries with the selected bigger profile
- [ ] task_started event shows the new profile
- [ ] Missing profile → blocked with clear message
- [ ] Existing recovery actions (retry-same-worker, skip, abort) unchanged
- [ ] `npm run test-ci` passes
