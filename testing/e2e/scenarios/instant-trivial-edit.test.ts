import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeE2eScenarioConfig } from '../helpers/config.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/harness.js';

const scenario = {
  name: 'instant mode - trivial edit',
  cassetteName: 'instant-trivial-edit',
  feature: 'fix typo in README',
  mode: 'instant' as const,
  config: makeE2eScenarioConfig('instant'),
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
    expect(readFileSync(join(ctx.projectDir, 'README.md'), 'utf-8')).toBe(
      '# Tiny Spec\n\nA small fixture project for e2e replay.',
    );

    expect(summary.tokenUsage.plannerInput + summary.tokenUsage.implementerInput).toBeGreaterThan(
      0,
    );
    expect(summary.tokenUsage.plannerOutput + summary.tokenUsage.implementerOutput).toBeGreaterThan(
      0,
    );
  });
});
