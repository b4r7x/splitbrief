import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeCustomCommand } from '../../core/config/custom-commands.js';
import { matches } from '../../utils/error.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  customRunnerSecurityPosture,
  markCustomRunnerTrusted,
  type ConfiguredCustomRunner,
} from '../runners/custom-trust.js';
import { resolveCustomExecutable } from '../runners/resolve-cli-executable.js';
import { customRunnerAdmissionError } from '../runners/trust.js';
import type { CustomRunnerRuntimePort } from '../runners/types.js';
import {
  createConfiguredCustomImplementer as createPreparedConfiguredCustomImplementer,
  type ConfiguredCustomImplementerOptions,
} from './command-invoke.js';
import { prepareCustomRunnerAdmission } from '../runners/custom-admission.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

async function createConfiguredCustomImplementer(
  options: Omit<ConfiguredCustomImplementerOptions, 'admission'> & {
    runner: ConfiguredCustomRunner;
  },
) {
  const admission = await prepareCustomRunnerAdmission({
    ...options.runtime.admission,
    projectDir: options.runtime.authorizationProjectDir,
    runner: options.runner,
    posture: customRunnerSecurityPosture('implementer', options.runner.command.contract),
    phase: 'implementing',
    authorizationPathEnv: options.runtime.authorizationPathEnv ?? '',
    authorizationPathExt: options.runtime.authorizationPathExt ?? '',
  });
  if (admission.kind !== 'admitted') throw customRunnerAdmissionError.denied('implementer');
  return createPreparedConfiguredCustomImplementer({
    runtime: options.runtime,
    ...(options.factoryOptions === undefined ? {} : { factoryOptions: options.factoryOptions }),
    admission: admission.invocation,
  });
}

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

async function implement(
  implementer: Awaited<ReturnType<typeof createConfiguredCustomImplementer>>,
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
  it('constructs with named runner, runtime, and factoryOptions while preserving publisher wiring', async () => {
    const projectDir = projectDirectory('configured-implementer-named-options');
    const harness = runtimeHarness(projectDir);
    const publisher = {
      publishRunning: vi.fn(),
      publishCallEvent: vi.fn(),
      publishDone: vi.fn(),
      publishFailed: vi.fn(),
      publishWarning: vi.fn(),
    };
    const implementer = await createConfiguredCustomImplementer({
      runner: configuredRunner({
        argv: ['-e', "process.stdout.write('```ts\\nexport const namedOptions = true;\\n```\\n');"],
      }),
      runtime: harness.runtime,
      factoryOptions: { publisher },
    });

    const result = await implement(implementer, projectDir, {
      file: 'src/named-options.ts',
      phase: 'implementing',
    });

    expect(result.success).toBe(true);
    expect(publisher.publishRunning).toHaveBeenCalledOnce();
    expect(publisher.publishDone).toHaveBeenCalledOnce();
    expect(publisher.publishFailed).not.toHaveBeenCalled();
  });

  it('uses the typed admission denial before it stages, spawns, or falls back', async () => {
    const projectDir = projectDirectory('configured-implementer-admission-denied');
    const childStarted = join(projectDir, 'denied-child-started');
    const harness = runtimeHarness(projectDir, {
      admission: { interaction: 'headless', allowRepoRunners: false },
    });
    const denied = customRunnerAdmissionError.denied('implementer');

    await expect(
      createConfiguredCustomImplementer({
        runner: configuredRunner({
          argv: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(childStarted)}, 'started');`,
          ],
        }),
        runtime: harness.runtime,
      }),
    ).rejects.toMatchObject({
      kind: 'custom-runner-admission-denied',
      message: 'Configured custom runner admission was denied.',
    });

    expect(matches('custom-runner-admission-denied')(denied)).toBe(true);
    expect(denied).toMatchObject({
      kind: 'custom-runner-admission-denied',
      message: 'Configured custom runner admission was denied.',
    });
    expect(denied.data).toBeUndefined();
    expect(existsSync(childStarted)).toBe(false);
    expect(harness.stages).toEqual([]);
  });

  it('runs output runners in a disposable child stage, applies parsed output to the base target, and uses only runtime source env', async () => {
    const projectDir = projectDirectory('configured-implementer-output-project');
    const harness = runtimeHarness(projectDir, {
      sourceEnv: { CUSTOM_IMPLEMENTER_MODE: 'runtime-source-canary' },
    });
    const childProgram = [
      "const fs = require('node:fs');",
      "fs.writeFileSync('stage-only-write.txt', 'discard this write');",
      "const selected = process.env.CUSTOM_IMPLEMENTER_MODE === 'runtime-source-canary' ? 'runtime-source' : process.env.CUSTOM_IMPLEMENTER_MODE === 'sandbox-canary' ? 'sandbox' : 'missing';",
      "process.stdout.write('```ts\\nexport const childCwd = ' + JSON.stringify(process.cwd()) + ';\\nexport const selected = ' + JSON.stringify(selected) + ';\\n```\\n');",
    ].join('');
    const implementer = await createConfiguredCustomImplementer({
      runner: configuredRunner({
        argv: ['-e', childProgram],
        env: ['CUSTOM_IMPLEMENTER_MODE'],
      }),
      runtime: harness.runtime,
    });

    const result = await implement(implementer, projectDir, {
      file: 'src/output.ts',
      sandboxEnv: { CUSTOM_IMPLEMENTER_MODE: 'sandbox-canary' },
    });

    expect(result.success).toBe(true);
    expect(implementer.capabilities).toEqual({ writesFiles: 'extracted-code' });
    expect(harness.stages).toHaveLength(1);
    const stageDir = harness.stages[0];
    if (stageDir === undefined) throw new Error('Output runner did not receive a child stage');
    const applied = readFileSync(join(projectDir, 'src', 'output.ts'), 'utf8');
    expect(applied).toContain(`childCwd = ${JSON.stringify(stageDir)}`);
    expect(applied).toContain('selected = "runtime-source"');
    expect(applied).not.toContain('sandbox');
    expect(existsSync(join(projectDir, 'stage-only-write.txt'))).toBe(false);
    expect(existsSync(stageDir)).toBe(false);
  });

  it('runs direct runners in the supplied outer stage, detects their change, and leaves nested-stage cleanup upstream', async () => {
    const authorizationProjectDir = projectDirectory('configured-implementer-direct-auth');
    const outerStageDir = projectDirectory('configured-implementer-direct-outer');
    const nestedStageMarker = join(authorizationProjectDir, 'nested-stage-requested');
    const harness = runtimeHarness(authorizationProjectDir, {
      sourceEnv: { CUSTOM_DIRECT_MODE: 'runtime-direct-canary' },
      onCreateStage: () => writeFileSync(nestedStageMarker, 'unexpected nested stage'),
    });
    const childProgram = [
      "const fs = require('node:fs');",
      "fs.mkdirSync('src', { recursive: true });",
      "const selected = process.env.CUSTOM_DIRECT_MODE === 'runtime-direct-canary' ? 'runtime-source' : process.env.CUSTOM_DIRECT_MODE === 'sandbox-direct-canary' ? 'sandbox' : 'missing';",
      "fs.writeFileSync('src/direct.ts', 'export const direct = ' + JSON.stringify(selected) + ';\\n');",
      "process.stdout.write('direct write complete');",
    ].join('');
    const implementer = await createConfiguredCustomImplementer({
      runner: configuredRunner({
        contract: 'direct',
        argv: ['-e', childProgram],
        env: ['CUSTOM_DIRECT_MODE'],
      }),
      runtime: harness.runtime,
    });

    const result = await implement(implementer, outerStageDir, {
      file: 'src/direct.ts',
      sandboxEnv: { CUSTOM_DIRECT_MODE: 'sandbox-direct-canary' },
    });

    expect(result.success).toBe(true);
    expect(implementer.capabilities).toEqual({ writesFiles: 'direct' });
    expect(readFileSync(join(outerStageDir, 'src', 'direct.ts'), 'utf8')).toContain(
      'direct = "runtime-source"',
    );
    expect(existsSync(join(authorizationProjectDir, 'src', 'direct.ts'))).toBe(false);
    expect(existsSync(nestedStageMarker)).toBe(false);
    expect(harness.stages).toEqual([]);
  });

  it('rejects a required value missing from runtime source env before the child starts, even when sandbox env supplies it', async () => {
    const projectDir = projectDirectory('configured-implementer-missing-source');
    const childStarted = join(projectDir, 'missing-source-child-started');
    const harness = runtimeHarness(projectDir, { sourceEnv: {} });
    const childProgram = [
      `require('node:fs').writeFileSync(${JSON.stringify(childStarted)}, 'started');`,
      "process.stdout.write('```ts\\nexport const shouldNotExist = true;\\n```\\n');",
    ].join('');
    const implementer = await createConfiguredCustomImplementer({
      runner: configuredRunner({ argv: ['-e', childProgram], env: ['CUSTOM_REQUIRED_VALUE'] }),
      runtime: harness.runtime,
    });

    const result = await implement(implementer, projectDir, {
      file: 'src/missing-source.ts',
      sandboxEnv: { CUSTOM_REQUIRED_VALUE: 'sandbox-only-canary' },
    });

    expect(result.success).toBe(false);
    expect(existsSync(childStarted)).toBe(false);
    expect(existsSync(join(projectDir, 'src', 'missing-source.ts'))).toBe(false);
    expect(harness.stages).toHaveLength(1);
    expect(existsSync(harness.stages[0] ?? '')).toBe(false);
  });

  itUnix(
    'does not fall back to source or ambient PATH when the captured authorization PATH is absent',
    { timeout: 30_000 },
    async () => {
      const projectDir = projectDirectory('configured-implementer-empty-authorization-path');
      const temptingBin = temporaryDirectory('configured-implementer-empty-authorization-bin');
      const executableName = 'configured-implementer';
      const temptingExecutable = join(temptingBin, executableName);
      const childStarted = join(projectDir, 'tempting-child-started');
      const stageRequested = join(projectDir, 'unexpected-stage');
      writeFileSync(
        temptingExecutable,
        `#!/bin/sh\nprintf tempting > ${JSON.stringify(childStarted)}\n`,
      );
      chmodSync(temptingExecutable, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = [temptingBin, originalPath].filter(Boolean).join(delimiter);
      try {
        const harness = runtimeHarness(projectDir, {
          authorizationPathEnv: '',
          sourceEnv: { PATH: temptingBin },
          onCreateStage: () => writeFileSync(stageRequested, 'unexpected stage'),
        });
        await expect(
          createConfiguredCustomImplementer({
            runner: configuredRunner({ executable: executableName }),
            runtime: harness.runtime,
          }),
        ).rejects.toMatchObject({ kind: 'custom-runner-admission-denied' });

        expect(harness.runtime.authorizationPathEnv).toBe('');
        expect(existsSync(childStarted)).toBe(false);
        expect(existsSync(stageRequested)).toBe(false);
        expect(existsSync(join(projectDir, 'src', 'path-absent.ts'))).toBe(false);
        expect(harness.stages).toEqual([]);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    },
  );

  itUnix(
    'fails closed on authorization PATH drift before it starts either executable and cleans its stage',
    async () => {
      const projectDir = projectDirectory('configured-implementer-path-drift');
      const stateDir = temporaryDirectory('configured-implementer-path-state');
      const admittedBin = join(projectDir, 'admitted-bin');
      const replacementBin = join(projectDir, 'replacement-bin');
      const executableName = 'configured-implementer';
      const admittedExecutable = join(admittedBin, executableName);
      const replacementExecutable = join(replacementBin, executableName);
      const admittedStarted = join(projectDir, 'admitted-executable-started');
      const replacementStarted = join(projectDir, 'replacement-executable-started');
      const stageRequested = join(projectDir, 'stage-requested');
      mkdirSync(admittedBin);
      mkdirSync(replacementBin);
      writeFileSync(
        admittedExecutable,
        `#!/bin/sh\nprintf admitted > ${JSON.stringify(admittedStarted)}\n`,
      );
      writeFileSync(
        replacementExecutable,
        `#!/bin/sh\nprintf replacement > ${JSON.stringify(replacementStarted)}\n`,
      );
      chmodSync(admittedExecutable, 0o755);
      chmodSync(replacementExecutable, 0o755);
      const runner = configuredRunner({ executable: executableName });
      const posture = customRunnerSecurityPosture('implementer', 'output');
      const resolution = await resolveCustomExecutable({
        command: executableName,
        projectDir,
        pathEnv: admittedBin,
      });
      if (resolution.kind !== 'resolved')
        throw new Error('Admitted test executable did not resolve');
      const trusted = await markCustomRunnerTrusted({
        projectDir,
        stateDir,
        runner,
        posture,
        executable: resolution.executable,
      });
      if (trusted.kind !== 'trusted') throw new Error('Admitted test executable was not trusted');
      const harness = runtimeHarness(projectDir, {
        sourceEnv: {},
        authorizationPathEnv: admittedBin,
        admission: { interaction: 'headless', allowRepoRunners: false, stateDir },
        onCreateStage: () => writeFileSync(stageRequested, 'unexpected stage'),
      });
      const implementer = await createConfiguredCustomImplementer({
        runner,
        runtime: harness.runtime,
      });
      Object.defineProperty(harness.runtime, 'authorizationPathEnv', { value: replacementBin });

      const result = await implement(implementer, projectDir, { file: 'src/path-drift.ts' });

      expect(result.success).toBe(false);
      expect(existsSync(stageRequested)).toBe(true);
      expect(existsSync(admittedStarted)).toBe(false);
      expect(existsSync(replacementStarted)).toBe(false);
      expect(harness.stages).toHaveLength(1);
      expect(existsSync(harness.stages[0] ?? '')).toBe(false);
    },
  );

  itUnix(
    'uses authorization PATH instead of a competing source-env PATH to select the child executable',
    async () => {
      const projectDir = projectDirectory('configured-implementer-competing-path');
      const authorizationBin = join(projectDir, 'authorization-bin');
      const sourceEnvBin = join(projectDir, 'source-env-bin');
      const executableName = 'configured-implementer';
      const authorizationExecutable = join(authorizationBin, executableName);
      const sourceEnvExecutable = join(sourceEnvBin, executableName);
      const authorizationStarted = join(projectDir, 'authorization-executable-started');
      const sourceEnvStarted = join(projectDir, 'source-env-executable-started');
      mkdirSync(authorizationBin);
      mkdirSync(sourceEnvBin);
      writeFileSync(
        authorizationExecutable,
        [
          '#!/bin/sh',
          `printf authorized > ${JSON.stringify(authorizationStarted)}`,
          'printf \'```ts\\nexport const selectedExecutable = "authorization";\\n```\\n\'',
        ].join('\n'),
      );
      writeFileSync(
        sourceEnvExecutable,
        [
          '#!/bin/sh',
          `printf source-env > ${JSON.stringify(sourceEnvStarted)}`,
          'printf \'```ts\\nexport const selectedExecutable = "source-env";\\n```\\n\'',
        ].join('\n'),
      );
      chmodSync(authorizationExecutable, 0o755);
      chmodSync(sourceEnvExecutable, 0o755);
      const harness = runtimeHarness(projectDir, {
        authorizationPathEnv: authorizationBin,
        sourceEnv: { PATH: sourceEnvBin },
      });
      const implementer = await createConfiguredCustomImplementer({
        runner: configuredRunner({ executable: executableName }),
        runtime: harness.runtime,
      });

      const result = await implement(implementer, projectDir, { file: 'src/authority.ts' });

      expect(result.success).toBe(true);
      expect(readFileSync(join(projectDir, 'src', 'authority.ts'), 'utf8')).toContain(
        'selectedExecutable = "authorization"',
      );
      expect(existsSync(authorizationStarted)).toBe(true);
      expect(existsSync(sourceEnvStarted)).toBe(false);
    },
  );
});
