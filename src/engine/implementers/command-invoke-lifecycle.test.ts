import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configuredRunner,
  createConfiguredCustomImplementer,
  createConfiguredImplementerFixtures,
  implement,
} from '#testing/helpers/configured-custom-implementer.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';

const { temporaryDirectory, projectDirectory, runtimeHarness } =
  createConfiguredImplementerFixtures();

describe('createConfiguredCustomImplementer', () => {
  it('cleans an output child stage after a configured idle timeout without applying parsed output', {
    timeout: 30_000,
  }, async () => {
    const projectDir = projectDirectory('configured-implementer-timeout');
    const outsideDir = temporaryDirectory('configured-implementer-timeout-outside');
    const childStarted = join(outsideDir, 'timeout-child-started');
    const targetPath = join(projectDir, 'src', 'timeout.ts');
    writeFileSync(targetPath, 'export const preserved = true;\n');
    const harness = runtimeHarness(projectDir, { sourceEnv: {} });
    const implementer = await createConfiguredCustomImplementer({
      runner: configuredRunner({
        argv: [
          '-e',
          [
            `require('node:fs').writeFileSync(${JSON.stringify(childStarted)}, 'started');`,
            "process.stdout.write('```ts\\nexport const shouldNotApply = true;\\n```\\n');",
            'setInterval(() => undefined, 1_000);',
          ].join(''),
        ],
        idleWarnMs: 1_000,
        idleKillMs: 3_000,
      }),
      runtime: harness.runtime,
    });

    const result = await implement(implementer, projectDir, { file: 'src/timeout.ts' });

    expect(result.success).toBe(false);
    expect(existsSync(childStarted)).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe('export const preserved = true;\n');
    expect(harness.stages).toHaveLength(1);
    expect(existsSync(harness.stages[0] ?? '')).toBe(false);
  });

  it('discards output-limit text and cleans the child stage without replacing an existing target', {
    timeout: 30_000,
  }, async () => {
    const projectDir = projectDirectory('configured-implementer-output-limit');
    const targetPath = join(projectDir, 'src', 'output-limit.ts');
    const outsideDir = temporaryDirectory('configured-implementer-output-limit-outside');
    const childStarted = join(outsideDir, 'output-limit-child-started');
    writeFileSync(targetPath, 'export const preserved = true;\n');
    const harness = runtimeHarness(projectDir, { sourceEnv: {} });
    const implementer = await createConfiguredCustomImplementer({
      runner: configuredRunner({
        argv: [
          '-e',
          [
            `require('node:fs').writeFileSync(${JSON.stringify(childStarted)}, 'started');`,
            "process.stdout.write('```ts\\nexport const shouldNotApply = true;\\n```\\n');",
            "process.stdout.write('x'.repeat(1_400_000));",
          ].join(''),
        ],
      }),
      runtime: harness.runtime,
    });

    const result = await implement(implementer, projectDir, { file: 'src/output-limit.ts' });

    expect(result.success).toBe(false);
    expect(existsSync(childStarted)).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe('export const preserved = true;\n');
    expect(harness.stages).toHaveLength(1);
    expect(existsSync(harness.stages[0] ?? '')).toBe(false);
  });

  it('does not promote direct staged writes after a configured output-limit breach', {
    timeout: 30_000,
  }, async () => {
    const authorizationProjectDir = projectDirectory('configured-implementer-output-limit-auth');
    const outerStageDir = projectDirectory('configured-implementer-output-limit-stage');
    const outsideDir = temporaryDirectory('configured-implementer-output-limit-outside');
    const childStarted = join(outsideDir, 'output-limit-child-started');
    const promotedPath = join(authorizationProjectDir, 'src', 'should-not-promote.ts');
    writeFileSync(promotedPath, 'export const canonical = true;\n');
    const harness = runtimeHarness(authorizationProjectDir, { sourceEnv: {} });
    const implementer = await createConfiguredCustomImplementer({
      runner: configuredRunner({
        contract: 'direct',
        argv: [
          '-e',
          [
            "const fs = require('node:fs');",
            `fs.writeFileSync(${JSON.stringify(childStarted)}, 'started');`,
            "fs.writeFileSync('src/should-not-promote.ts', 'export const stagedOnly = true;\\n');",
            "process.stdout.write('```ts\\nexport const shouldNotApply = true;\\n```\\n');",
            "process.stdout.write('x'.repeat(1_400_000));",
          ].join(''),
        ],
      }),
      runtime: harness.runtime,
    });

    const result = await implement(implementer, outerStageDir, {
      file: 'src/should-not-promote.ts',
    });

    expect(result.success).toBe(false);
    expect(existsSync(childStarted)).toBe(true);
    expect(existsSync(join(outerStageDir, 'src', 'should-not-promote.ts'))).toBe(true);
    expect(readFileSync(promotedPath, 'utf8')).toBe('export const canonical = true;\n');
    expect(harness.stages).toEqual([]);
    cleanupTempDir(outerStageDir);
    expect(existsSync(outerStageDir)).toBe(false);
  });

  it('cleans every output child stage after completed, failed, malformed-output, and aborted calls', async () => {
    const projectDir = projectDirectory('configured-implementer-cleanup');
    const harness = runtimeHarness(projectDir, { sourceEnv: {} });
    const cases: ReadonlyArray<{
      name: string;
      argv: readonly string[];
      expectedSuccess: boolean;
      abort?: boolean;
    }> = [
      {
        name: 'completed',
        argv: ['-e', "process.stdout.write('```ts\\nexport const completed = true;\\n```\\n');"],
        expectedSuccess: true,
      },
      {
        name: 'failed',
        argv: ['-e', 'process.exitCode = 1;'],
        expectedSuccess: false,
      },
      {
        name: 'malformed output',
        argv: ['-e', "process.stdout.write('this is not fenced code');"],
        expectedSuccess: false,
      },
      {
        name: 'aborted',
        argv: ['-e', 'setInterval(() => undefined, 1_000);'],
        expectedSuccess: false,
        abort: true,
      },
    ];

    for (const testCase of cases) {
      const implementer = await createConfiguredCustomImplementer({
        runner: configuredRunner({ argv: testCase.argv }),
        runtime: harness.runtime,
      });
      const controller = new AbortController();
      const abortTimer = testCase.abort ? setTimeout(() => controller.abort(), 100) : undefined;
      try {
        const result = await implement(implementer, projectDir, {
          file: 'src/cleanup.ts',
          ...(testCase.abort ? { signal: controller.signal } : {}),
        });
        expect(result.success, testCase.name).toBe(testCase.expectedSuccess);
      } finally {
        if (abortTimer !== undefined) clearTimeout(abortTimer);
      }

      const stageDir = harness.stages.at(-1);
      if (stageDir === undefined) throw new Error(`${testCase.name} call did not create a stage`);
      expect(existsSync(stageDir), testCase.name).toBe(false);
    }
  });
});
