import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateTsArtifact } from '../helpers/artifact-assertions.js';
import { makeE2eScenarioConfig } from '../helpers/e2e-config.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/e2e-harness.js';

const scenario = {
  name: 'standard mode - multi-task feature',
  cassetteName: 'standard-multi-task',
  feature: 'add user profile page with API and tests',
  mode: 'standard' as const,
  config: makeE2eScenarioConfig('standard', { workflow: { approve: 'none' } }),
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
    const profilePath = join(ctx.projectDir, 'src/profile.ts');
    expect(readFileSync(profilePath, 'utf-8')).toContain('Ada Lovelace');
    expect(evaluateTsArtifact(profilePath, 'mod.getUserProfile()')).toEqual({
      id: 'user-1',
      name: 'Ada Lovelace',
      role: 'admin',
    });
    expect(readFileSync(join(ctx.projectDir, 'src/profile.test.ts'), 'utf-8')).toContain('getUserProfile');
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
