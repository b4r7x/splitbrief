import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeCustomCommand } from '../../core/config/custom-commands.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  customRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from '../runners/custom-trust.js';
import { prepareCustomRunnerAdmission } from '../runners/custom-admission.js';
import type { RunnerGate } from '../runners/prepared-execution.js';
import type { CustomRunnerRuntimePort } from '../runners/types.js';
import { createConfiguredCustomImplementer } from './command-invoke.js';

let directories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = createTempDir(prefix);
  directories.push(directory);
  return directory;
}

function projectDirectory(prefix: string): string {
  const projectDir = temporaryDirectory(prefix);
  mkdirSync(join(projectDir, 'src'));
  return projectDir;
}

function configuredRunner(
  input: Readonly<{
    contract?: 'output' | 'direct';
    executable?: string;
    argv?: readonly string[];
    env?: readonly string[];
    idleWarnMs?: number;
    idleKillMs?: number;
  }> = {},
): ConfiguredCustomRunner {
  return {
    source: 'configured',
    command: normalizeCustomCommand('configured-implementer-test', {
      label: 'Configured implementer test',
      contract: input.contract ?? 'output',
      executable: input.executable ?? process.execPath,
      argv: input.argv === undefined ? [] : [...input.argv],
      env: input.env === undefined ? [] : [...input.env],
      ...(input.idleWarnMs === undefined ? {} : { idleWarnMs: input.idleWarnMs }),
      ...(input.idleKillMs === undefined ? {} : { idleKillMs: input.idleKillMs }),
    }),
  };
}

type RuntimeHarnessOptions = Readonly<{
  sourceEnv?: NodeJS.ProcessEnv;
  authorizationPathEnv?: string;
  authorizationPathExt?: string;
  admission?: CustomRunnerRuntimePort['admission'];
  onCreateStage?: (sourceProjectDir: string, role: 'planner' | 'implementer') => void;
}>;

type RuntimeHarness = Readonly<{
  runtime: CustomRunnerRuntimePort;
  stages: string[];
}>;

function runtimeHarness(
  authorizationProjectDir: string,
  options: RuntimeHarnessOptions = {},
): RuntimeHarness {
  const stateDir = temporaryDirectory('configured-implementer-state');
  const stageParent = temporaryDirectory('configured-implementer-stages');
  const stages: string[] = [];
  let stageNumber = 0;

  const runtime: CustomRunnerRuntimePort = {
    sessionId: 'configured-implementer-test-session',
    authorizationProjectDir,
    sourceEnv: options.sourceEnv ?? {},
    ...(options.authorizationPathEnv === undefined
      ? {}
      : { authorizationPathEnv: options.authorizationPathEnv }),
    ...(options.authorizationPathExt === undefined
      ? {}
      : { authorizationPathExt: options.authorizationPathExt }),
    admission:
      options.admission ??
      ({
        interaction: 'headless',
        allowRepoRunners: true,
        stateDir,
      } satisfies CustomRunnerRuntimePort['admission']),
    createStage: async (sourceProjectDir, role) => {
      options.onCreateStage?.(sourceProjectDir, role);
      const createdProjectDir = join(stageParent, `stage-${++stageNumber}`);
      mkdirSync(createdProjectDir);
      const projectDir = realpathSync(createdProjectDir);
      stages.push(projectDir);
      return {
        projectDir,
        snapshot: { head: '', files: [], dirtyFileContents: {} },
        cleanup: () => cleanupTempDir(projectDir),
      };
    },
    cleanupStaleArtifactReviews: async () => undefined,
    beginDeclaredArtifactReview: async () => ({
      reviewAfterChild: async () => '',
      dispose: async () => undefined,
    }),
  };

  return { runtime, stages };
}

async function createPreparedImplementer(
  runner: ConfiguredCustomRunner,
  runtime: CustomRunnerRuntimePort,
) {
  const admission = await prepareCustomRunnerAdmission({
    ...runtime.admission,
    projectDir: runtime.authorizationProjectDir,
    runner,
    posture: customRunnerSecurityPosture('implementer', runner.command.contract),
    phase: 'implementing',
    authorizationPathEnv: runtime.authorizationPathEnv ?? '',
    authorizationPathExt: runtime.authorizationPathExt ?? '',
  });
  if (admission.kind !== 'admitted') throw new Error('Expected configured runner admission.');
  const gate = {
    kind: runner.command.contract === 'output' ? 'shell' : 'agent',
    slot: { role: 'implementer', profile: 'default' },
    preparationId: 'command-invoke-lifecycle',
    command: { kind: 'configured-custom', invocation: admission.invocation },
  } satisfies RunnerGate;
  return createConfiguredCustomImplementer({
    runtime,
    admission: gate.command.invocation,
  });
}

async function implement(
  implementer: Awaited<ReturnType<typeof createPreparedImplementer>>,
  projectDir: string,
  options: Readonly<{
    file: string;
    signal?: AbortSignal;
    sandboxEnv?: NodeJS.ProcessEnv;
    phase?: 'implementing';
  }>,
) {
  return implementer.implement({
    task: makeTask({ file: options.file, action: 'create' }),
    projectDir,
    config: makeConfig(),
    context: { ...defaultContext, dir: projectDir },
    onOutput: () => undefined,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.sandboxEnv === undefined ? {} : { sandboxEnv: options.sandboxEnv }),
    ...(options.phase === undefined ? {} : { phase: options.phase }),
  });
}

afterEach(() => {
  for (const directory of directories) cleanupTempDir(directory);
  directories = [];
});

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
    const implementer = await createPreparedImplementer(
      configuredRunner({
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
      harness.runtime,
    );

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
    const implementer = await createPreparedImplementer(
      configuredRunner({
        argv: [
          '-e',
          [
            `require('node:fs').writeFileSync(${JSON.stringify(childStarted)}, 'started');`,
            "process.stdout.write('```ts\\nexport const shouldNotApply = true;\\n```\\n');",
            "process.stdout.write('x'.repeat(1_400_000));",
          ].join(''),
        ],
      }),
      harness.runtime,
    );

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
    const implementer = await createPreparedImplementer(
      configuredRunner({
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
      harness.runtime,
    );

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
      const implementer = await createPreparedImplementer(
        configuredRunner({ argv: testCase.argv }),
        harness.runtime,
      );
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
