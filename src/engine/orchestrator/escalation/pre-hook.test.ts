import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { setupProject } from '#testing/helpers/state-ops.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { createEventBus } from '../../events/bus.js';
import type { EngineEvent } from '../../events/types.js';
import { preEscalationHalt } from './pre-hook.js';

let trustHome: ReturnType<typeof useTrustHome>;
const projectDirs: string[] = [];

beforeEach(() => {
  trustHome = useTrustHome('pre-escalation-trust-home');
});

afterEach(() => {
  for (const dir of projectDirs.splice(0)) cleanupTempDir(dir);
  trustHome.restore();
});

function hookAnswering(decision: 'allow' | 'deny'): HooksConfig {
  return {
    pre_escalation: [
      {
        kind: 'command',
        command: 'node',
        args: [
          '-e',
          `console.log(JSON.stringify({ decision: '${decision}', message: 'policy: escalation not allowed' }))`,
        ],
        timeout_ms: 30_000,
        on_failure: 'warn',
      },
    ],
  };
}

async function escalate(hooks: HooksConfig | undefined) {
  const { projectDir, sessionId } = setupProject();
  projectDirs.push(projectDir);
  if (hooks !== undefined) markHooksConfigTrusted(projectDir, hooks);
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const task = makeTask({ id: 'T001' });
  // The first call is booked on the lineage before the ladder.
  const state = transition(makeImplState([task]), { type: 'COUNT_ATTEMPT', taskId: task.id });
  const ctx = {
    projectDir,
    workspaceDir: projectDir,
    sessionId,
    bus,
    config: makeNoValidationConfig(hooks === undefined ? {} : { hooks }),
  };
  const halted = await preEscalationHalt(ctx, state, task, 'type error');
  return { ctx, halted, events };
}

describe('the pre_escalation hook', () => {
  it('halts the brief Needs you on a refusal, attributed to the hook, before any consult', async () => {
    const { ctx, halted, events } = await escalate(hookAnswering('deny'));

    expect(halted?.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
      message: 'T001 escalation blocked by pre_escalation hook: policy: escalation not allowed',
      facts: {
        escalationBlockedBy: 'policy: escalation not allowed',
        validationSummary: 'type error',
      },
    });
    expect(halted?.pendingRecovery?.details).toContain('Attempts: 1');
    expect(loadState(ctx)?.pendingRecovery?.reason).toBe('retry-exhausted');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message: 'pre_escalation blocked: policy: escalation not allowed',
      }),
    );
  });

  it('lets the brief escalate when the hook allows it or no hook is set', async () => {
    const allowed = await escalate(hookAnswering('allow'));
    const unset = await escalate(undefined);

    expect(allowed.halted).toBeUndefined();
    expect(unset.halted).toBeUndefined();
    expect([...allowed.events, ...unset.events]).toEqual([]);
  });
});
