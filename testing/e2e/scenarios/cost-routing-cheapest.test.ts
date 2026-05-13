import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateTsArtifact } from '../helpers/artifact-assertions.js';
import { e2eImplementer, e2ePlanner, makeE2eScenarioConfig } from '../helpers/e2e-config.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/e2e-harness.js';

const scenario = {
  name: 'cost routing - cheapest capable profile',
  cassetteName: 'cost-routing-cheapest',
  feature: 'add utility function',
  mode: 'quick' as const,
  config: makeE2eScenarioConfig('quick', {
    implementerProfiles: {
      default: 'cheap-local',
      profiles: {
        'cheap-local': {
          ...e2eImplementer,
          costTier: 'local',
          contextLength: 200000,
        },
        'expensive-cloud': {
          ...e2ePlanner,
          costTier: 'frontier',
          contextLength: 200000,
        },
      },
    },
  }),
};

describe('e2e: cost routing cheapest capable', () => {
  const ctx = setupE2eScenario(scenario);

  it('routes to the cheapest profile when the task fits', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    const taskStarted = ctx.events.find((event) => event.type === 'task_started');
    expect(taskStarted).toBeDefined();
    expect(taskStarted?.implementerProfile).toBe('cheap-local');
    const utilityPath = join(ctx.projectDir, 'src/utility.ts');
    expect(readFileSync(utilityPath, 'utf-8')).toContain('toTitleCase');
    expect(evaluateTsArtifact(utilityPath, "mod.toTitleCase('hello WORLD')")).toBe('Hello World');

    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
  });
});
