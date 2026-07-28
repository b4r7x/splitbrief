import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateTsArtifact } from '../helpers/artifact-assertions.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { CliToolId } from '../../../src/core/schemas/enums.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const runRealCliSmoke = process.env.SPLITBRIEF_REAL_CLI_E2E === '1';
const itReal = runRealCliSmoke ? it : it.skip;

function realCliTool(name: string, fallback: CliToolId): CliToolId {
  return (process.env[name] as CliToolId | undefined) ?? fallback;
}

describe('real CLI smoke: planner to implementer', () => {
  itReal(
    'runs configured real planner and implementer CLI binaries through runWorkflow',
    async () => {
      resetAllStores();
      const projectDir = createTempDir('real-cli-planner-implementer');
      try {
        createTestGitRepo(projectDir);
        writeFileSync(
          join(projectDir, 'validate.mjs'),
          [
            "const { realCliSmoke } = await import('./src/real-cli-smoke.ts');",
            "if (realCliSmoke !== 'real-cli-smoke') process.exit(1);",
          ].join('\n') + '\n',
          'utf-8',
        );

        const plannerTool = realCliTool('SPLITBRIEF_REAL_CLI_PLANNER', 'codex');
        const implementerTool = realCliTool('SPLITBRIEF_REAL_CLI_IMPLEMENTER', 'opencode');
        const summary = await runWorkflow({
          feature:
            'Create src/real-cli-smoke.ts exporting a string constant named realCliSmoke with value "real-cli-smoke".',
          projectDir,
          config: makeConfig({
            planner: {
              kind: 'cli',
              tool: plannerTool,
              ...(process.env.SPLITBRIEF_REAL_CLI_PLANNER_MODEL
                ? { model: process.env.SPLITBRIEF_REAL_CLI_PLANNER_MODEL }
                : {}),
            },
            implementer: {
              kind: 'cli',
              tool: implementerTool,
              ...(process.env.SPLITBRIEF_REAL_CLI_IMPLEMENTER_MODEL
                ? { model: process.env.SPLITBRIEF_REAL_CLI_IMPLEMENTER_MODEL }
                : {}),
              contextLength: 4096,
            },
            validation: {
              typecheck: false,
              lint: false,
              test: true,
              testCommand: 'node validate.mjs',
            },
            workflow: {
              mode: 'quick',
              approve: 'none',
              commitStrategy: 'none',
              maxRetries: 1,
              persistTranscript: true,
            },
          }),
          callbacks: makeCallbacks().callbacks,
          sinks: TEST_WORKFLOW_SINKS,
          sessionId: 'sess-real-cli-planner-implementer',
        });

        expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
        expect(summary.failed).toBe(0);
        const smokePath = join(projectDir, 'src/real-cli-smoke.ts');
        expect(evaluateTsArtifact(smokePath, 'mod.realCliSmoke')).toBe('real-cli-smoke');
        expect(existsSync(join(projectDir, '.splitbrief'))).toBe(true);
      } finally {
        cleanupTempDir(projectDir);
      }
    },
    180_000,
  );
});
