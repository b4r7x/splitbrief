import { describe, expect, it } from 'vitest';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/e2e-harness.js';

const e2eApiBase = process.env.DIPTYCH_E2E_API_BASE ?? 'http://localhost:11434/v1';
const replayApiKey = process.env.DIPTYCH_E2E_RECORD === '1'
  ? undefined
  : 'e2e-placeholder';

const scenario = {
  name: 'standard mode - multi-task feature',
  cassetteName: 'standard-multi-task',
  feature: 'add user profile page with API and tests',
  mode: 'standard' as const,
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
      mode: 'standard',
      commitStrategy: 'none',
      approve: 'none',
    },
    validation: {
      typecheck: false,
      lint: false,
      test: false,
      testCommand: 'npm test',
    },
  },
};

describe('e2e: standard mode multi-task', () => {
  const ctx = setupE2eScenario(scenario);

  it('plans multiple tasks, completes them sequentially, and emits cost updates', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    expect(summary.totalTasks).toBeGreaterThanOrEqual(2);

    const taskStartedEvents = ctx.events.filter((event) => event.type === 'task_started');
    const taskCompletedEvents = ctx.events.filter((event) => event.type === 'task_completed');
    expect(taskStartedEvents.length).toBeGreaterThanOrEqual(2);
    expect(taskCompletedEvents.length).toBeGreaterThanOrEqual(2);
    expect(taskStartedEvents.map((event) => event.index)).toEqual(
      taskStartedEvents.map((_, index) => index),
    );

    const planningStatuses = ctx.events.filter(
      (event) =>
        event.type === 'planner_status' &&
        (event.phase === 'planning' || event.phase === 'reviewing-plan'),
    );
    expect(planningStatuses.length).toBeGreaterThan(0);

    const costEvents = ctx.events.filter((event) => event.type === 'cost_update');
    expect(costEvents.length).toBeGreaterThan(0);
    expect(summary.tokenUsage.plannerInput + summary.tokenUsage.implementerInput).toBeGreaterThan(0);
    expect(summary.tokenUsage.plannerOutput + summary.tokenUsage.implementerOutput).toBeGreaterThan(0);
  });
});
