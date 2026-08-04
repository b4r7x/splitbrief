import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  makeBusRecorder,
  makeImplementer,
  makePlanner,
  makeCallbacks,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { ConfigSchema, type Config } from '../../../core/schemas/config.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { createImplementer } from '../../runners/factory.js';
import type { CustomRunnerRuntimePort } from '../../runners/types.js';
import type { RunnerGate } from '../../runners/prepared-execution.js';
import { resolveConfiguredCustomRunner } from '../../runners/configured-custom.js';
import { customRunnerSecurityPosture } from '../../runners/custom-trust.js';
import { prepareCustomRunnerAdmission } from '../../runners/custom-admission.js';
import { customRunnerAdmissionError } from '../../runners/trust.js';
import { createStagedProject } from '../approval/staged-project.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createValidator } from '../validation/run.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { stateForRetryProfile, createRetryRuntime } from './retry-runtime.js';
import { configForProfile } from '../task/routing.js';
import type { EscalationContext } from './types.js';

let dirs: string[] = [];

type CustomContract = 'output' | 'direct';

type RealCommandOptions = Readonly<{
  argvById?: Partial<Record<'default-id' | 'retry-id', string[]>>;
  outputFormat?: 'jsonl' | 'text';
}>;

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('retry-runtime-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-retry-runtime';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function configWithProfiles() {
  return {
    ...makeNoValidationConfig({
      approval: { enabled: false, feedRejectionsToPlanner: true },
      workflow: {},
    }),
    implementerProfiles: {
      default: 'cheap-large',
      profiles: {
        'cheap-large': {
          kind: 'api' as const,
          provider: 'deepseek',
          service: 'deepseek',
          offering: 'payg' as const,
          apiBase: 'https://api.deepseek.com/v1',
          apiKey: 'test-key',
          model: 'deepseek-chat',
          costTier: 'cheap' as const,
          contextLength: 128_000,
        },
      },
    },
  };
}

function retryConfigWithContracts(
  defaultContract: CustomContract,
  retryContract: CustomContract,
  options: RealCommandOptions = {},
): Config {
  const command = (contract: CustomContract, id: string) => ({
    label: id,
    contract,
    executable: process.execPath,
    argv: options.argvById?.[id as 'default-id' | 'retry-id'] ?? [`--${id}`],
    outputFormat: options.outputFormat ?? ('jsonl' as const),
    idleWarnMs: 4_000,
    idleKillMs: 8_000,
    env: [],
  });
  const profile = (contract: CustomContract, id: string) => {
    const definition = command(contract, id);
    return {
      kind: contract === 'output' ? ('shell' as const) : ('agent' as const),
      command: definition.executable,
      args: definition.argv,
      outputFormat: definition.outputFormat,
      idleWarnMs: definition.idleWarnMs,
      idleKillMs: definition.idleKillMs,
      env: definition.env,
      model: `${id}-model`,
      label: `${id} label`,
      costTier: id === 'retry-id' ? ('frontier' as const) : ('cheap' as const),
      capabilities: {
        writesFiles: contract === 'output' ? ('extracted-code' as const) : ('direct' as const),
      },
    };
  };

  return ConfigSchema.parse({
    ...makeNoValidationConfig({ approval: { enabled: false, feedRejectionsToPlanner: true } }),
    implementerProfiles: {
      default: 'default-profile',
      profiles: {
        'default-profile': profile(defaultContract, 'default-id'),
        'retry-profile': profile(retryContract, 'retry-id'),
      },
    },
    customCommands: {
      'default-id': command(defaultContract, 'default-id'),
      'retry-id': command(retryContract, 'retry-id'),
    },
  });
}

function runnerRecord(id: string, contract: CustomContract): string {
  return JSON.stringify({
    stableId: id,
    executable: process.execPath,
    contract,
    writesFiles: contract === 'output' ? 'extracted-code' : 'direct',
  });
}

function retryChildProgram(
  input: Readonly<{
    id: string;
    contract: CustomContract;
    markerPath: string;
    taskFile: string;
  }>,
): string {
  const record = runnerRecord(input.id, input.contract);
  const source = `export const retryRunner = ${record} as const;\n`;
  const marker = `require('node:fs').writeFileSync(${JSON.stringify(input.markerPath)}, ${JSON.stringify(record)});`;
  if (input.contract === 'output') {
    return `${marker}process.stdout.write(${JSON.stringify(`\`\`\`ts\n${source}\`\`\`\n`)});`;
  }
  return [
    "const fs = require('node:fs');",
    marker,
    "fs.mkdirSync('src', { recursive: true });",
    `fs.writeFileSync(${JSON.stringify(input.taskFile)}, ${JSON.stringify(source)});`,
  ].join('');
}

function configuredRetryRuntime(
  input: Readonly<{
    projectDir: string;
    sessionId: string;
    stateDir: string;
    allowRepoRunners: boolean;
  }>,
): CustomRunnerRuntimePort {
  return {
    sessionId: input.sessionId,
    authorizationProjectDir: input.projectDir,
    sourceEnv: {},
    authorizationPathEnv: process.env.PATH ?? '',
    ...(process.env.PATHEXT === undefined ? {} : { authorizationPathExt: process.env.PATHEXT }),
    createStage: async (projectDir) => {
      const staged = await createStagedProject(projectDir);
      return {
        projectDir: staged.projectDir,
        snapshot: staged.snapshot,
        cleanup: staged.cleanup,
      };
    },
    admission: {
      interaction: 'headless',
      allowRepoRunners: input.allowRepoRunners,
      stateDir: input.stateDir,
    },
    cleanupStaleArtifactReviews: async () => {},
    beginDeclaredArtifactReview: async () => {
      throw new Error('Configured implementer must not begin planner artifact review.');
    },
  };
}

async function configuredRetryContext(
  input: Readonly<{
    projectDir: string;
    sessionId: string;
    config: Config;
    runtime: CustomRunnerRuntimePort;
  }>,
): Promise<EscalationContext> {
  const { callbacks } = makeCallbacks();
  const { bus } = makeBusRecorder();
  const preparationId = 'configured-retry-preparation';
  const gates: RunnerGate[] = [];
  for (const profile of resolveImplementerProfiles(input.config).profiles) {
    const profileConfig = configForProfile(input.config, profile);
    const runner = resolveConfiguredCustomRunner(profileConfig, 'implementer');
    if (runner === null) continue;
    const admission = await prepareCustomRunnerAdmission({
      ...input.runtime.admission,
      projectDir: input.runtime.authorizationProjectDir,
      runner,
      posture: customRunnerSecurityPosture('implementer', runner.command.contract),
      phase: 'implementing',
      authorizationPathEnv: input.runtime.authorizationPathEnv ?? '',
      authorizationPathExt: input.runtime.authorizationPathExt ?? '',
    });
    if (admission.kind !== 'admitted') throw customRunnerAdmissionError.denied('implementer');
    gates.push({
      kind: runner.command.contract === 'output' ? 'shell' : 'agent',
      slot: { role: 'implementer', profile: profile.name },
      preparationId,
      command: { kind: 'configured-custom', invocation: admission.invocation },
    });
  }
  return {
    projectDir: input.projectDir,
    sessionId: input.sessionId,
    config: input.config,
    callbacks,
    bus,
    planner: makePlanner(),
    context: { name: 'retry configured runner', dir: input.projectDir },
    implementer: makeImplementer(),
    createImplementer: (runnerConfig, factoryOptions) =>
      createImplementer(input.config, {
        ...factoryOptions,
        customRuntime: input.runtime,
        preparedConfig: input.config,
        preparationId,
        gates,
        slot: factoryOptions?.slot ?? { role: 'implementer', profile: 'default' },
        ...(factoryOptions?.slot?.role === 'intermediate' &&
          runnerConfig.implementer.contextLength !== undefined && {
            intermediateContextLength: runnerConfig.implementer.contextLength,
          }),
      }),
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    validator: createValidator(),
    taskStartSnapshot: await getChangedFilesSnapshot(input.projectDir),
    dependsOnFiles: [],
  };
}

describe('stateForRetryProfile', () => {
  it('updates implementer tool and model from profile', () => {
    const state = makeImplState([], { implementerTool: 'ollama', implementerModel: 'qwen' });
    const profile = {
      name: 'test',
      config: {
        kind: 'api' as const,
        provider: 'openai',
        service: 'openai',
        offering: 'payg' as const,
        apiBase: 'https://api.openai.com/v1',
        apiKey: 'key',
        model: 'gpt-4',
        costTier: 'frontier' as const,
        contextLength: 8192,
      },
      costTier: 'frontier' as const,
      capabilities: { writesFiles: 'direct' as const },
      isDefault: false,
    };
    const result = stateForRetryProfile(state, profile);
    expect(result.implementerTool).toBe('openai');
    expect(result.implementerModel).toBe('gpt-4');
  });

  it('preserves existing implementerModel when profile model is unchanged', () => {
    const state = makeImplState([], { implementerTool: 'ollama', implementerModel: 'qwen' });
    const profile = {
      name: 'test',
      config: {
        kind: 'api' as const,
        provider: 'openai',
        service: 'openai',
        offering: 'payg' as const,
        apiBase: 'https://api.openai.com/v1',
        apiKey: 'key',
        model: 'qwen',
        costTier: 'frontier' as const,
        contextLength: 8192,
      },
      costTier: 'frontier' as const,
      capabilities: { writesFiles: 'direct' as const },
      isDefault: false,
    };
    const result = stateForRetryProfile(state, profile);
    expect(result.implementerTool).toBe('openai');
    expect(result.implementerModel).toBe('qwen');
  });
});

describe('createRetryRuntime', () => {
  it('returns existing implementer when no override', async () => {
    const { projectDir, sessionId } = setupProject();
    const config = configWithProfiles();
    const { bus } = makeBusRecorder();
    const implementer = makeImplementer();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const { callbacks } = makeCallbacks();
    const ctx: EscalationContext = {
      projectDir,
      sessionId,
      config,
      callbacks,
      bus,
      planner: makePlanner(),
      context: { name: 'test', dir: projectDir },
      implementer,
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      taskStartSnapshot,
      dependsOnFiles: [],
    };

    const runtime = await createRetryRuntime(ctx, undefined);

    expect(runtime.config).toBe(config);
    expect(runtime.implementer).toBe(implementer);
    expect(runtime.implementerProfile).toBeUndefined();
  });

  it('throws for nonexistent profile', async () => {
    const { projectDir, sessionId } = setupProject();
    const config = configWithProfiles();
    const { bus } = makeBusRecorder();
    const implementer = makeImplementer();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const { callbacks } = makeCallbacks();
    const ctx: EscalationContext = {
      projectDir,
      sessionId,
      config,
      callbacks,
      bus,
      planner: makePlanner(),
      context: { name: 'test', dir: projectDir },
      implementer,
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      taskStartSnapshot,
      dependsOnFiles: [],
    };

    await expect(createRetryRuntime(ctx, 'nonexistent')).rejects.toThrow(/nonexistent/);
  });

  it.each([
    ['output', 'direct'],
    ['direct', 'output'],
  ] as const)('runs the selected %s-to-%s retry runner through a real child without fallback', async (defaultContract, retryContract) => {
    const { projectDir, sessionId } = setupProject();
    const markerDir = createTempDir('retry-configured-runner-markers');
    const stateDir = createTempDir('retry-configured-runner-state');
    dirs.push(markerDir, stateDir);
    const taskFile = `src/retry-${retryContract}.ts`;
    const defaultMarker = join(markerDir, 'default.json');
    const retryMarker = join(markerDir, 'retry.json');
    const config = retryConfigWithContracts(defaultContract, retryContract, {
      outputFormat: 'text',
      argvById: {
        'default-id': [
          '-e',
          retryChildProgram({
            id: 'default-id',
            contract: defaultContract,
            markerPath: defaultMarker,
            taskFile,
          }),
        ],
        'retry-id': [
          '-e',
          retryChildProgram({
            id: 'retry-id',
            contract: retryContract,
            markerPath: retryMarker,
            taskFile,
          }),
        ],
      },
    });
    const childRuntime = configuredRetryRuntime({
      projectDir,
      sessionId,
      stateDir,
      allowRepoRunners: true,
    });
    const ctx = await configuredRetryContext({
      projectDir,
      sessionId,
      config,
      runtime: childRuntime,
    });
    const retryRuntime = await createRetryRuntime(ctx, 'retry-profile');
    const task = makeTask({ id: 'T001', file: taskFile });

    if (retryContract === 'direct') {
      const staged = await createStagedProject(projectDir, retryRuntime.config);
      try {
        const result = await retryRuntime.implementer.retry({
          task,
          projectDir: staged.projectDir,
          config: retryRuntime.config,
          context: ctx.context,
          error: 'first attempt failed',
          attempt: 1,
          kind: 'local',
          onOutput: () => {},
          sandboxEnv: staged.sandboxEnv,
          fileIgnoreProjectDir: projectDir,
        });

        expect(result.success).toBe(true);
        expect(readFileSync(join(staged.projectDir, taskFile), 'utf8')).toContain(
          runnerRecord('retry-id', retryContract),
        );
      } finally {
        staged.cleanup();
      }
    } else {
      const result = await retryRuntime.implementer.retry({
        task,
        projectDir,
        config: retryRuntime.config,
        context: ctx.context,
        error: 'first attempt failed',
        attempt: 1,
        kind: 'local',
        onOutput: () => {},
      });

      expect(result.success).toBe(true);
      expect(readFileSync(join(projectDir, taskFile), 'utf8')).toContain(
        runnerRecord('retry-id', retryContract),
      );
    }

    expect(retryRuntime.implementer.capabilities).toEqual({
      writesFiles: retryContract === 'output' ? 'extracted-code' : 'direct',
    });
    expect(readFileSync(retryMarker, 'utf8')).toBe(runnerRecord('retry-id', retryContract));
    expect(existsSync(defaultMarker)).toBe(false);
  });

  it.each([
    ['output', 'direct'],
    ['direct', 'output'],
  ] as const)('denies the selected %s-to-%s retry runner before either selected or fallback child starts', async (defaultContract, retryContract) => {
    const { projectDir, sessionId } = setupProject();
    const markerDir = createTempDir('retry-denied-runner-markers');
    const stateDir = createTempDir('retry-denied-runner-state');
    dirs.push(markerDir, stateDir);
    const taskFile = `src/retry-denied-${retryContract}.ts`;
    const defaultMarker = join(markerDir, 'default.json');
    const retryMarker = join(markerDir, 'retry.json');
    const config = retryConfigWithContracts(defaultContract, retryContract, {
      outputFormat: 'text',
      argvById: {
        'default-id': [
          '-e',
          retryChildProgram({
            id: 'default-id',
            contract: defaultContract,
            markerPath: defaultMarker,
            taskFile,
          }),
        ],
        'retry-id': [
          '-e',
          retryChildProgram({
            id: 'retry-id',
            contract: retryContract,
            markerPath: retryMarker,
            taskFile,
          }),
        ],
      },
    });
    const childRuntime = configuredRetryRuntime({
      projectDir,
      sessionId,
      stateDir,
      allowRepoRunners: false,
    });
    await expect(
      configuredRetryContext({
        projectDir,
        sessionId,
        config,
        runtime: childRuntime,
      }),
    ).rejects.toMatchObject({ kind: 'custom-runner-admission-denied' });
    expect(existsSync(retryMarker)).toBe(false);
    expect(existsSync(defaultMarker)).toBe(false);
  });
});
