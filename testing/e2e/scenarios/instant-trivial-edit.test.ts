import { describe, expect, it } from 'vitest';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/e2e-harness.js';

const e2eApiBase = process.env.DIPTYCH_E2E_API_BASE ?? 'http://localhost:11434/v1';
const replayApiKey = process.env.DIPTYCH_E2E_RECORD === '1'
  ? undefined
  : 'e2e-placeholder';

const scenario = {
  name: 'instant mode - trivial edit',
  cassetteName: 'instant-trivial-edit',
  feature: 'fix typo in README',
  mode: 'instant' as const,
  config: {
    version: 2,
    planner: {
      kind: 'api',
      provider: 'openai',
      apiBase: e2eApiBase,
      ...(replayApiKey ? { apiKey: replayApiKey } : {}),
      model: 'gpt-4o',
    },
    implementer: {
      kind: 'api',
      provider: 'openai',
      apiBase: e2eApiBase,
      ...(replayApiKey ? { apiKey: replayApiKey } : {}),
      model: 'gpt-4o-mini',
    },
    workflow: {
      mode: 'instant',
      commitStrategy: 'none',
    },
    validation: {
      typecheck: false,
      lint: false,
      test: false,
      testCommand: 'npm test',
    },
  },
};

describe('e2e: instant mode trivial edit', () => {
  const ctx = setupE2eScenario(scenario);

  it('completes one task via cheap implementer and emits workflow_complete', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    expect(summary.totalTasks).toBe(1);
    expect(summary.completedByLocal).toBeGreaterThanOrEqual(1);

    const started = ctx.events.find((event) => event.type === 'workflow_started');
    const completed = ctx.events.find((event) => event.type === 'workflow_complete');
    expect(started).toBeDefined();
    expect(completed).toBeDefined();

    const taskCompleted = ctx.events.find((event) => event.type === 'task_completed');
    expect(taskCompleted).toBeDefined();

    expect(summary.tokenUsage.plannerInput + summary.tokenUsage.implementerInput).toBeGreaterThan(0);
    expect(summary.tokenUsage.plannerOutput + summary.tokenUsage.implementerOutput).toBeGreaterThan(0);
  });
});
