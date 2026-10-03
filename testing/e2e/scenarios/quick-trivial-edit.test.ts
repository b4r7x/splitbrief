import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeE2eScenarioConfig } from '../helpers/config.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/harness.js';

const scenario = {
  name: 'planning session - trivial edit',
  cassetteName: 'quick-trivial-edit',
  feature: 'fix typo in README',
  config: makeE2eScenarioConfig(),
};

describe('e2e: one-task plan makes a trivial edit', () => {
  const ctx = setupE2eScenario(scenario);

  it('completes one task via cheap implementer and emits workflow_complete', async () => {
    // The request fixes a README, so the fixture project carries one: the
    // planner context packet refuses to dispatch when the file the request
    // names as existing is absent.
    writeFileSync(
      join(ctx.projectDir, 'README'),
      '# SPLITBRIEF\n\nA small fixure project for e2e replay.\n',
      'utf-8',
    );
    const summary = await runE2eWorkflow(ctx, scenario);

    expect(summary.totalTasks).toBe(1);
    expect(summary.completedByLocal).toBeGreaterThanOrEqual(1);

    const started = ctx.events.find((event) => event.type === 'workflow_started');
    const completed = ctx.events.find((event) => event.type === 'workflow_complete');
    expect(started).toBeDefined();
    expect(completed).toBeDefined();

    const taskCompleted = ctx.events.find((event) => event.type === 'task_completed');
    expect(taskCompleted).toBeDefined();
    expect(readFileSync(join(ctx.projectDir, 'README.md'), 'utf-8')).toBe(
      '# SPLITBRIEF\n\nA small fixture project for e2e replay.',
    );

    expect(summary.tokenUsage.plannerInput + summary.tokenUsage.implementerInput).toBeGreaterThan(
      0,
    );
    expect(summary.tokenUsage.plannerOutput + summary.tokenUsage.implementerOutput).toBeGreaterThan(
      0,
    );
  });
});
