import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { createEventBus } from '../../events/bus.js';
import { parsePreparedConfig, type PreparedExecution } from '../../runners/prepared-execution.js';
import { createIpcWorkflowBridge } from '../workflow-bridge.js';
import type { IpcServer } from '../server.js';
import { runWorkflowLoop } from './run.js';

describe('runWorkflowLoop', () => {
  it('detached recovery reuses prepared runner authority across retries', async () => {
    const mutableConfig = makeConfig({ workflow: { maxRetries: 2 } });
    const preparedConfig = parsePreparedConfig(mutableConfig);
    const gate = {
      kind: 'api' as const,
      slot: { role: 'planner' as const },
      preparationId: 'detached-preparation',
      provider: 'openai',
      endpointOrigin: 'https://api.openai.com',
    };
    const receipt = {
      version: 1 as const,
      sessionId: 'detached-retry',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const prepared: PreparedExecution = {
      purpose: 'new-workflow',
      config: preparedConfig,
      preparationId: gate.preparationId,
      report: {
        generatedAt: '2026-08-04T00:00:00.000Z',
        projectDir: '/repo',
        status: 'ready',
        counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
        nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
        sections: [],
        metadata: {},
      },
      gates: [gate],
      session: {
        kind: 'new',
        ref: { projectDir: '/repo', sessionId: receipt.sessionId },
        ownership: receipt,
        active: receipt,
      },
      runtime: {
        feature: 'retry without changing authority',
        allowRepoRunners: false,
        allowHooks: false,
      },
    };
    const bus = createEventBus();
    const bridge = createIpcWorkflowBridge(bus);
    const server: IpcServer = {
      sockPath: '/tmp/detached-retry.sock',
      requestClientPrompt: async () => ({
        kind: 'recovery_needed',
        action: 'retry-same-worker',
      }),
      close: async () => {},
    };
    const attempts: PreparedExecution[] = [];

    const summary = await runWorkflowLoop({ prepared }, server, bridge, bus, async (options) => {
      attempts.push(options.prepared);
      if (attempts.length === 1) {
        mutableConfig.workflow.maxRetries = 99;
        return makeSummary({
          totalTasks: 1,
          completedByLocal: 0,
          failed: 1,
        });
      }
      return makeSummary({ totalTasks: 1, completedByLocal: 1, failed: 0 });
    });

    expect(summary.failed).toBe(0);
    expect(attempts).toEqual([prepared, prepared]);
    expect(attempts[1]?.gates[0]).toBe(gate);
    expect(Object.isFrozen(preparedConfig)).toBe(true);
    expect(attempts[1]?.config).toBe(preparedConfig);
    expect(attempts[1]?.config.workflow.maxRetries).toBe(2);
  });
});
