import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSION_LOG_FILE, sessionsRoot } from '../../../src/core/paths.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/e2e-harness.js';

const anthropicApiBase = 'https://api.anthropic.com/v1';
const replayApiKey = process.env.DIPTYCH_E2E_RECORD === '1'
  ? undefined
  : 'sk-ant-e2e-placeholder';

const scenario = {
  name: 'quick mode - add endpoint',
  cassetteName: 'quick-add-endpoint',
  feature: 'add GET /api/health endpoint',
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
    },
    validation: {
      typecheck: false,
      lint: false,
      test: false,
      testCommand: 'npm test',
    },
  },
};

function hasSessionArtifact(projectDir: string, fileName: string): boolean {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return false;
  return readdirSync(root, { withFileTypes: true }).some((entry) =>
    entry.isDirectory() && existsSync(join(root, entry.name, fileName))
  );
}

describe('e2e: quick mode add endpoint', () => {
  const ctx = setupE2eScenario(scenario);

  it('completes planning and implementation with session artifacts and token usage', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);

    const plannerEvents = ctx.events.filter((event) => event.type === 'planner_status');
    expect(plannerEvents.length).toBeGreaterThan(0);

    const taskEvents = ctx.events.filter((event) => event.type === 'task_completed');
    expect(taskEvents.length).toBeGreaterThanOrEqual(1);

    expect(hasSessionArtifact(ctx.projectDir, SESSION_LOG_FILE)).toBe(true);
    expect(summary.totalTime).toBeGreaterThan(0);

    expect(summary.tokenUsage.plannerInput).toBeGreaterThan(0);
    expect(summary.tokenUsage.plannerOutput).toBeGreaterThan(0);
    expect(summary.tokenUsage.implementerInput).toBeGreaterThan(0);
    expect(summary.tokenUsage.implementerOutput).toBeGreaterThan(0);
  });
});
