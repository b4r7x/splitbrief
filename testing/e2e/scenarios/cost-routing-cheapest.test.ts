import { describe, expect, it } from 'vitest';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/e2e-harness.js';

const anthropicApiBase = 'https://api.anthropic.com/v1';
const replayApiKey = process.env.DIPTYCH_E2E_RECORD === '1'
  ? undefined
  : 'sk-ant-e2e-placeholder';

const scenario = {
  name: 'cost routing - cheapest capable profile',
  cassetteName: 'cost-routing-cheapest',
  feature: 'add utility function',
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
    implementerProfiles: {
      default: 'cheap-local',
      profiles: {
        'cheap-local': {
          kind: 'api',
          provider: 'anthropic',
          apiBase: anthropicApiBase,
          ...(replayApiKey ? { apiKey: replayApiKey } : {}),
          model: 'claude-haiku-4-5-20251001',
          costTier: 'local',
          contextLength: 200000,
        },
        'expensive-cloud': {
          kind: 'api',
          provider: 'anthropic',
          apiBase: anthropicApiBase,
          ...(replayApiKey ? { apiKey: replayApiKey } : {}),
          model: 'claude-sonnet-4-6',
          costTier: 'frontier',
          contextLength: 200000,
        },
      },
    },
    workflow: {
      mode: 'quick',
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

describe('e2e: cost routing cheapest capable', () => {
  const ctx = setupE2eScenario(scenario);

  it('routes to the cheapest profile when the task fits', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    const taskStarted = ctx.events.find((event) => event.type === 'task_started');
    expect(taskStarted).toBeDefined();
    expect(taskStarted?.implementerProfile).toBe('cheap-local');

    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
  });
});
