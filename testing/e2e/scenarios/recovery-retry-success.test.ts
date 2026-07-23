import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateTsArtifact } from '../helpers/artifact-assertions.js';
import { makeE2eScenarioConfig } from '../helpers/config.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/harness.js';

const scenario = {
  name: 'recovery - task fails then retries successfully',
  cassetteName: 'recovery-retry-success',
  feature: 'add validation to form handler',
  mode: 'quick' as const,
  config: makeE2eScenarioConfig('quick', { workflow: { maxRetries: 2 } }),
};

describe('e2e: recovery retry success', () => {
  const ctx = setupE2eScenario(scenario);

  it('retries failed task and eventually completes', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    const retryEvents = ctx.events.filter((event) => event.type === 'task_retry');
    const taskCompleted = ctx.events.filter((event) => event.type === 'task_completed');

    expect(retryEvents.length).toBeGreaterThan(0);
    expect(taskCompleted.length).toBeGreaterThan(0);
    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
    const validationPath = join(ctx.projectDir, 'src/form-validation.ts');
    expect(
      evaluateTsArtifact(validationPath, "mod.validateForm({ email: 'ada@example.com' })"),
    ).toEqual({ valid: true, errors: [] });
    expect(evaluateTsArtifact(validationPath, "mod.validateForm({ email: 'broken' }).valid")).toBe(
      false,
    );
  });
});
