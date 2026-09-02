import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { normalizeCustomCommand } from '../../src/core/config/custom-commands.js';
import {
  createConfiguredCustomImplementer as createPreparedImplementer,
  type ConfiguredCustomImplementerOptions,
} from '../../src/engine/implementers/command-invoke.js';
import type { Implementer } from '../../src/engine/implementers/types.js';
import { prepareCustomRunnerAdmission } from '../../src/engine/runners/custom-admission.js';
import { customRunnerAdmissionError } from '../../src/engine/runners/custom-launchability.js';
import {
  customRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from '../../src/engine/runners/custom-trust.js';
import type { CustomRunnerRuntimePort } from '../../src/engine/runners/types.js';
import { makeConfig, defaultContext } from './factories/config.js';
import { makeTask } from './factories/task.js';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

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

export function configuredRunner(
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

export async function createConfiguredCustomImplementer(
  options: Omit<ConfiguredCustomImplementerOptions, 'admission'> & {
    runner: ConfiguredCustomRunner;
  },
): Promise<Implementer> {
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
  return createPreparedImplementer({
    runtime: options.runtime,
    ...(options.factoryOptions === undefined ? {} : { factoryOptions: options.factoryOptions }),
    admission: admission.invocation,
  });
}

export function implement(
  implementer: Implementer,
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

export function createConfiguredImplementerFixtures() {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) cleanupTempDir(directory);
  });

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
        readWithReceiptAfterChild: async () => {
          throw new Error('not used by implementer tests');
        },
        get receipt() {
          return undefined;
        },
        getReceipt: () => undefined,
        dispose: async () => undefined,
      }),
    };

    return { runtime, stages };
  }

  return { temporaryDirectory, projectDirectory, runtimeHarness };
}
