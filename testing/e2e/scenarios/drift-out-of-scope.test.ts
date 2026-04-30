import { describe, expect, it } from 'vitest';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/e2e-harness.js';

const e2eApiBase = process.env.DIPTYCH_E2E_API_BASE ?? 'http://localhost:11434/v1';
const replayApiKey = process.env.DIPTYCH_E2E_RECORD === '1'
  ? undefined
  : 'e2e-placeholder';

const scenario = {
  name: 'drift detection - out of scope writes',
  cassetteName: 'drift-out-of-scope',
  feature: 'update config parser',
  mode: 'quick' as const,
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

describe('e2e: drift out-of-scope detection', () => {
  const ctx = setupE2eScenario(scenario);

  it('does not crash when drift analysis reports out-of-scope writes', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);

    if (summary.driftSummary) {
      expect(ctx.events.some((event) => event.type === 'drift_report')).toBe(true);
    }
    if (summary.chainDriftSummary) {
      expect(ctx.events.some((event) => event.type === 'drift_chain_detected')).toBe(true);
    }
  });
});
