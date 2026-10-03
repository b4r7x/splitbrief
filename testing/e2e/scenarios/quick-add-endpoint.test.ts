import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSION_LOG_FILE, sessionsRoot } from '../../../src/core/paths.js';
import { evaluateTsArtifact } from '../helpers/artifact-assertions.js';
import { makeE2eScenarioConfig } from '../helpers/config.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/harness.js';

const scenario = {
  name: 'planning session - add endpoint',
  cassetteName: 'quick-add-endpoint',
  // Spelled without the leading slash: the planner context packet reads an
  // explicitly named path as project evidence, and an absolute path can never
  // be read, so the run would refuse to dispatch.
  feature: 'add GET api/health endpoint',
  config: makeE2eScenarioConfig(),
};

function hasSessionArtifact(projectDir: string, fileName: string): boolean {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return false;
  return readdirSync(root, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && existsSync(join(root, entry.name, fileName)),
  );
}

describe('e2e: one-task plan adds an endpoint', () => {
  const ctx = setupE2eScenario(scenario);

  it('completes planning and implementation with session artifacts and token usage', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);

    const plannerEvents = ctx.events.filter((event) => event.type === 'planner_status');
    expect(plannerEvents.length).toBeGreaterThan(0);

    const taskEvents = ctx.events.filter((event) => event.type === 'task_completed');
    expect(taskEvents.length).toBeGreaterThanOrEqual(1);
    const healthPath = join(ctx.projectDir, 'src/health.ts');
    expect(evaluateTsArtifact(healthPath, 'mod.getHealth()')).toEqual({ status: 'ok' });

    expect(hasSessionArtifact(ctx.projectDir, SESSION_LOG_FILE)).toBe(true);
    expect(summary.totalTime).toBeGreaterThan(0);

    expect(summary.tokenUsage.plannerInput).toBeGreaterThan(0);
    expect(summary.tokenUsage.plannerOutput).toBeGreaterThan(0);
    expect(summary.tokenUsage.implementerInput).toBeGreaterThan(0);
    expect(summary.tokenUsage.implementerOutput).toBeGreaterThan(0);
  });
});
