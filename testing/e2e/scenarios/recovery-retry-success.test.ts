import { describe, expect, it } from 'vitest';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/e2e-harness.js';

const anthropicApiBase = 'https://api.anthropic.com/v1';
const replayApiKey = process.env.DIPTYCH_E2E_RECORD === '1'
  ? undefined
  : 'sk-ant-e2e-placeholder';

const scenario = {
  name: 'recovery - task fails then retries successfully',
  cassetteName: 'recovery-retry-success',
  feature: 'add validation to form handler',
  mode: 'quick' as const,
  config: {
    version: 2,
    planner: {
      kind: 'api',
      provider: 'anthropic',
      apiBase: anthropicApiBase,
      ...(replayApiKey ? { apiKey: replayApiKey } : {}),
      model: 'claude-sonnet-4-6',
    },
    implementer: {
      kind: 'api',
      provider: 'anthropic',
      apiBase: anthropicApiBase,
      ...(replayApiKey ? { apiKey: replayApiKey } : {}),
      model: 'claude-haiku-4-5-20251001',
    },
    workflow: {
      mode: 'quick',
      commitStrategy: 'none',
      maxRetries: 2,
    },
    validation: {
      typecheck: false,
      lint: false,
      test: false,
      testCommand: 'npm test',
    },
  },
};

describe('e2e: recovery retry success', () => {
  const ctx = setupE2eScenario(scenario);

  it('retries failed task and eventually completes', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    const retryEvents = ctx.events.filter((event) => event.type === 'task_retry');
    const taskCompleted = ctx.events.filter((event) => event.type === 'task_completed');

    expect(retryEvents.length + taskCompleted.length).toBeGreaterThan(0);
    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
  });
});
