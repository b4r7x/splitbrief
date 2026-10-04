import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REVIEW_PACKET_JSON_FILE } from '../../../src/core/paths.js';
import { ReviewPacketSchema } from '../../../src/core/schemas/review-packet.js';
import { evaluateTsArtifact } from '../helpers/artifact-assertions.js';
import { makeE2eScenarioConfig } from '../helpers/config.js';
import { runE2eWorkflow, setupE2eScenario } from '../helpers/harness.js';

const DRIFT_SCRIPT = '.splitbrief/hooks/write-drift.mjs';

const scenario = {
  name: 'drift detection - out of scope writes',
  cassetteName: 'drift-out-of-scope',
  feature: 'update config parser',
  config: makeE2eScenarioConfig({
    workflow: { driftChainThreshold: 0.01 },
    hooks: {
      pre_validation: [
        {
          kind: 'command',
          command: 'node',
          args: [DRIFT_SCRIPT],
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    },
  }),
};

describe('e2e: drift out-of-scope detection', () => {
  const ctx = setupE2eScenario(scenario);

  // The hook writes a file no Task Brief targets into the run workspace, which is
  // the deterministic drift this scenario measures. Hooks run in the checkout, so
  // the hook finds the workspace as the last worktree git lists.
  function installDriftHook(): void {
    mkdirSync(join(ctx.projectDir, '.splitbrief/hooks'), { recursive: true });
    writeFileSync(
      join(ctx.projectDir, DRIFT_SCRIPT),
      [
        "import { execFileSync } from 'node:child_process';",
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });",
        "const workspace = listed.split('\\n').filter((line) => line.startsWith('worktree ')).at(-1).slice('worktree '.length);",
        "mkdirSync(join(workspace, 'src'), { recursive: true });",
        "writeFileSync(join(workspace, 'src/out-of-scope.ts'), 'export const drift = true;\\n');",
        '',
      ].join('\n'),
    );
  }

  it('keeps the final drift report attribution-scoped and emits the out-of-scope drift chain', async () => {
    installDriftHook();
    const summary = await runE2eWorkflow(ctx, scenario);
    const driftReport = ctx.events.find((event) => event.type === 'drift_report');
    const driftChain = ctx.events.find((event) => event.type === 'drift_chain_detected');
    const parserPath = join(ctx.projectDir, 'src/config-parser.ts');

    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
    expect(
      evaluateTsArtifact(parserPath, "mod.parseConfig('name=splitbrief; enabled=true')"),
    ).toEqual({
      name: 'splitbrief',
      enabled: true,
    });
    expect(driftReport).toBeDefined();
    // The hook wrote into the run workspace while the brief ran, so its file is
    // part of the run and the final drift report stays free of errors...
    expect(driftReport?.passed).toBe(true);
    expect(driftReport?.errorCount).toBe(0);
    // ...while the per-task drift chain still reports the out-of-scope write.
    expect(driftChain).toMatchObject({
      type: 'drift_chain_detected',
      uniqueOutOfBoundsFiles: ['src/out-of-scope.ts'],
      representativePath: 'src/out-of-scope.ts',
    });

    // The write is not dropped: the review packet lists it among the workspace
    // files the run changed.
    const artifact = ctx.events.find((event) => event.type === 'artifact_written');
    if (artifact?.type !== 'artifact_written') throw new Error('no session artifact path recorded');
    const packet = ReviewPacketSchema.parse(
      JSON.parse(
        readFileSync(join(dirname(artifact.path), REVIEW_PACKET_JSON_FILE), 'utf8'),
      ) as unknown,
    );
    expect(packet.changes.provenance?.status).toBe('available');
    expect(packet.changes.provenance?.workspaceFiles).toContain('src/out-of-scope.ts');
  });
});
