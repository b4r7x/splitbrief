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

  // The hook writes a file no Task Brief targets, which is the deterministic
  // drift this scenario measures.
  function installDriftHook(): void {
    mkdirSync(join(ctx.projectDir, '.splitbrief/hooks'), { recursive: true });
    writeFileSync(
      join(ctx.projectDir, DRIFT_SCRIPT),
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('src', { recursive: true });",
        "writeFileSync('src/out-of-scope.ts', 'export const drift = true;\\n');",
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
    // Final-review drift attributes recorded promotions only. The hook wrote
    // straight to the workspace, so its file is not a run effect and the report
    // stays free of errors...
    expect(driftReport?.passed).toBe(true);
    expect(driftReport?.errorCount).toBe(0);
    // ...while the per-task drift chain still reports the out-of-scope write.
    expect(driftChain).toMatchObject({
      type: 'drift_chain_detected',
      uniqueOutOfBoundsFiles: ['src/out-of-scope.ts'],
      representativePath: 'src/out-of-scope.ts',
    });

    // The unattributed write is not dropped: the review packet keeps it visible
    // as uncertain workspace context.
    const artifact = ctx.events.find((event) => event.type === 'artifact_written');
    if (artifact?.type !== 'artifact_written') throw new Error('no session artifact path recorded');
    const packet = ReviewPacketSchema.parse(
      JSON.parse(
        readFileSync(join(dirname(artifact.path), REVIEW_PACKET_JSON_FILE), 'utf8'),
      ) as unknown,
    );
    expect(packet.changes.provenance?.status).toBe('missing');
    expect(packet.changes.provenance?.promotedFiles).toEqual([]);
    expect(packet.changes.provenance?.uncertainFiles).toContain('src/out-of-scope.ts');
  });
});
