import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateTsArtifact } from '../helpers/artifact-assertions.js';
import { e2eImplementer, e2ePlanner } from '../helpers/e2e-config.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/e2e-harness.js';

const scenario = {
  name: 'drift detection - out of scope writes',
  cassetteName: 'drift-out-of-scope',
  feature: 'update config parser',
  mode: 'quick' as const,
  config: {
    version: 2,
    planner: e2ePlanner,
    implementer: e2eImplementer,
    workflow: {
      mode: 'quick',
      commitStrategy: 'none',
      driftChainThreshold: 0.01,
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

  function installDriftHook(): void {
    mkdirSync(join(ctx.projectDir, '.diptych/hooks'), { recursive: true });
    writeFileSync(join(ctx.projectDir, '.diptych/hooks/pre-validation.js'), [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'export default function writeDrift(_event, ctx) {',
      "  mkdirSync(join(ctx.projectDir, 'src'), { recursive: true });",
      "  writeFileSync(join(ctx.projectDir, 'src/out-of-scope.ts'), 'export const drift = true;\\n');",
      "  return { kind: 'allow' };",
      '}',
      '',
    ].join('\n'));
  }

  it('detects deterministic drift and emits an out-of-scope drift chain', async () => {
    installDriftHook();
    const summary = await runE2eWorkflow(ctx, scenario);
    const driftReport = ctx.events.find((event) => event.type === 'drift_report');
    const driftChain = ctx.events.find((event) => event.type === 'drift_chain_detected');
    const parserPath = join(ctx.projectDir, 'src/config-parser.ts');

    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
    expect(readFileSync(parserPath, 'utf-8')).toContain('parseConfig');
    expect(evaluateTsArtifact(parserPath, "mod.parseConfig('name=diptych; enabled=true')")).toEqual({
      name: 'diptych',
      enabled: true,
    });
    expect(driftReport).toBeDefined();
    expect(driftReport?.passed).toBe(false);
    expect(driftReport?.errorCount).toBeGreaterThan(0);
    expect(driftChain).toMatchObject({
      type: 'drift_chain_detected',
      uniqueOutOfBoundsFiles: ['src/out-of-scope.ts'],
      representativePath: 'src/out-of-scope.ts',
    });
  });
});
