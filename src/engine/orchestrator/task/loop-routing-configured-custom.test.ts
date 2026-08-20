import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import { ConfigSchema } from '../../../core/schemas/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { createStagedProject } from '../approval/staged-project.js';
import { createImplementer } from '../../runners/factory.js';
import type { CustomRunnerRuntimePort } from '../../runners/types.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { resolveConfiguredCustomRunner } from '../../runners/configured-custom.js';
import { customRunnerSecurityPosture } from '../../runners/custom-trust.js';
import { prepareCustomRunnerAdmission } from '../../runners/custom-admission.js';
import type { RunnerGate } from '../../runners/prepared-execution.js';
import { configForProfile } from './routing.js';
import { runTaskLoop } from './loop.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'task-loop-test',
    sessionId: 'sess-loop',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

const defaultWorkflow = { maxRetries: 2 };

type CustomContract = 'output' | 'direct';

type RoutedRunner = Readonly<{
  id: string;
  profile: string;
  contract: CustomContract;
  costTier: 'cheap' | 'standard';
}>;

function writesFiles(contract: CustomContract): 'extracted-code' | 'direct' {
  return contract === 'output' ? 'extracted-code' : 'direct';
}

function executionRecord(runner: RoutedRunner): string {
  return JSON.stringify({
    stableId: runner.id,
    executable: process.execPath,
    contract: runner.contract,
    writesFiles: writesFiles(runner.contract),
  });
}

function expectedSource(runner: RoutedRunner): string {
  return `export const routedRunner = ${executionRecord(runner)} as const;\n`;
}

function runnerScript(
  input: Readonly<{
    runner: RoutedRunner;
    markerPath: string;
    taskFile: string;
  }>,
): string {
  const record = executionRecord(input.runner);
  const source = expectedSource(input.runner);
  const marker = `require('node:fs').writeFileSync(${JSON.stringify(input.markerPath)}, ${JSON.stringify(record)});`;

  if (input.runner.contract === 'output') {
    return [marker, `process.stdout.write(${JSON.stringify(`\`\`\`ts\n${source}\`\`\`\n`)});`].join(
      '',
    );
  }

  return [
    "const fs = require('node:fs');",
    marker,
    "fs.mkdirSync('src', { recursive: true });",
    `fs.writeFileSync(${JSON.stringify(input.taskFile)}, ${JSON.stringify(source)});`,
  ].join('');
}

function configuredRunner(runner: RoutedRunner, script: string) {
  const argv = ['-e', script];
  const common = {
    command: process.execPath,
    args: argv,
    outputFormat: 'text' as const,
    idleWarnMs: 300_000,
    idleKillMs: 1_800_000,
    env: [] as string[],
  };
  return {
    profile: {
      kind: runner.contract === 'output' ? ('shell' as const) : ('agent' as const),
      ...common,
      model: `${runner.id}-model`,
      contextLength: 32_768,
      costTier: runner.costTier,
      capabilities: { writesFiles: writesFiles(runner.contract) },
    },
    command: {
      label: `${runner.id} command`,
      contract: runner.contract,
      executable: process.execPath,
      argv,
      outputFormat: common.outputFormat,
      idleWarnMs: common.idleWarnMs,
      idleKillMs: common.idleKillMs,
      env: common.env,
    },
  };
}

function configuredProfileConfig(
  input: Readonly<{
    fallback: RoutedRunner;
    selected: RoutedRunner;
    fallbackMarkerPath: string;
    selectedMarkerPath: string;
    taskFile: string;
  }>,
): Config {
  const fallback = configuredRunner(
    input.fallback,
    runnerScript({
      runner: input.fallback,
      markerPath: input.fallbackMarkerPath,
      taskFile: input.taskFile,
    }),
  );
  const selected = configuredRunner(
    input.selected,
    runnerScript({
      runner: input.selected,
      markerPath: input.selectedMarkerPath,
      taskFile: input.taskFile,
    }),
  );
  const {
    costTier: _costTier,
    capabilities: _capabilities,
    ...fallbackImplementer
  } = fallback.profile;

  return ConfigSchema.parse({
    ...makeNoValidationConfig({
      workflow: { ...defaultWorkflow, persistTranscript: false },
      approval: { enabled: false, feedRejectionsToPlanner: true },
    }),
    implementer: fallbackImplementer,
    implementerProfiles: {
      default: input.fallback.profile,
      profiles: {
        [input.fallback.profile]: fallback.profile,
        [input.selected.profile]: selected.profile,
      },
    },
    customCommands: {
      [input.fallback.id]: fallback.command,
      [input.selected.id]: selected.command,
    },
  });
}

function configuredRuntime(
  input: Readonly<{
    projectDir: string;
    sessionId: string;
    stateDir: string;
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
    admission: { interaction: 'headless', allowRepoRunners: true, stateDir: input.stateDir },
    cleanupStaleArtifactReviews: async () => {},
    beginDeclaredArtifactReview: async () => {
      throw new Error('Configured implementer must not begin planner artifact review.');
    },
  };
}

async function configuredGates(
  config: Config,
  runtime: CustomRunnerRuntimePort,
  preparationId: string,
): Promise<readonly RunnerGate[]> {
  return Promise.all(
    resolveImplementerProfiles(config).profiles.map(async (profile) => {
      const runner = resolveConfiguredCustomRunner(
        configForProfile(config, profile),
        'implementer',
      );
      if (runner === null) throw new Error(`Expected configured runner for ${profile.name}.`);
      const admission = await prepareCustomRunnerAdmission({
        ...runtime.admission,
        projectDir: runtime.authorizationProjectDir,
        runner,
        posture: customRunnerSecurityPosture('implementer', runner.command.contract),
        phase: 'implementing',
        authorizationPathEnv: runtime.authorizationPathEnv ?? '',
        authorizationPathExt: runtime.authorizationPathExt ?? '',
      });
      if (admission.kind !== 'admitted') {
        throw new Error(`Expected configured runner admission for ${profile.name}.`);
      }
      return {
        kind: runner.command.contract === 'output' ? 'shell' : 'agent',
        slot: { role: 'implementer', profile: profile.name },
        preparationId,
        command: { kind: 'configured-custom', invocation: admission.invocation },
      } satisfies RunnerGate;
    }),
  );
}

describe('runTaskLoop configured custom routing', { timeout: 90_000 }, () => {
  it.each([
    {
      name: 'output default to direct selected profile',
      fallback: {
        id: 'default-output-stable-id',
        profile: 'default-output',
        contract: 'output' as const,
        costTier: 'cheap' as const,
      },
      selected: {
        id: 'selected-direct-stable-id',
        profile: 'selected-direct',
        contract: 'direct' as const,
        costTier: 'standard' as const,
      },
      scope: { inBounds: ['src/profile-direct.ts', 'src/another-in-scope-file.ts'] },
    },
    {
      name: 'direct default to output selected profile',
      fallback: {
        id: 'default-direct-stable-id',
        profile: 'default-direct',
        contract: 'direct' as const,
        costTier: 'standard' as const,
      },
      selected: {
        id: 'selected-output-stable-id',
        profile: 'selected-output',
        contract: 'output' as const,
        costTier: 'cheap' as const,
      },
    },
  ] as const)(
    'executes the selected configured runner without falling back for $name',
    async ({ fallback, selected, scope }) => {
      const { projectDir, sessionId } = setupProject();
      const markerDir = createTempDir('selected-configured-runner-markers');
      const stateDir = createTempDir('selected-configured-runner-state');
      dirs.push(markerDir, stateDir);
      const taskFile =
        selected.contract === 'direct' ? 'src/profile-direct.ts' : 'src/profile-output.ts';
      const selectedMarkerPath = join(markerDir, 'selected-runner.json');
      const fallbackMarkerPath = join(markerDir, 'fallback-runner.json');
      const task = makeTask({
        id: 'T001',
        file: taskFile,
        ...(scope === undefined ? {} : { scope: { inBounds: [...scope.inBounds] } }),
      });
      const config = configuredProfileConfig({
        fallback,
        selected,
        fallbackMarkerPath,
        selectedMarkerPath,
        taskFile,
      });
      const runtime = configuredRuntime({ projectDir, sessionId, stateDir });
      const preparationId = `task-loop-${sessionId}`;
      const gates = await configuredGates(config, runtime, preparationId);
      let dynamicImplementer: Awaited<ReturnType<typeof createImplementer>> | undefined;
      const { callbacks } = makeCallbacks();
      const { bus, events } = makeBusRecorder();

      const result = await runTaskLoop({
        wctx: makeWctx({
          projectDir,
          sessionId,
          config,
          callbacks,
          bus,
          allowRepoRunners: true,
          createImplementer: async (_profileConfig, options) => {
            if (options?.slot === undefined) throw new Error('Expected a named implementer slot.');
            dynamicImplementer = await createImplementer(config, {
              ...options,
              customRuntime: runtime,
              preparedConfig: config,
              preparationId,
              gates,
              slot: options.slot,
            });
            return dynamicImplementer;
          },
        }),
        initialState: makeImplState([task]),
        setTrackedState: () => {},
        setCurrentTask: () => {},
      });

      expect(result.status).toBe('complete');
      expect(dynamicImplementer?.capabilities).toEqual({
        writesFiles: writesFiles(selected.contract),
      });
      expect(readFileSync(selectedMarkerPath, 'utf8')).toBe(executionRecord(selected));
      expect(existsSync(fallbackMarkerPath)).toBe(false);
      expect(readFileSync(join(projectDir, taskFile), 'utf8').trimEnd()).toBe(
        expectedSource(selected).trimEnd(),
      );
      expect(events.find((event) => event.type === 'task_started')).toMatchObject({
        taskId: 'T001',
        implementerProfile: selected.profile,
      });
      expect(result.taskBreakdowns).toEqual([
        expect.objectContaining({
          taskId: 'T001',
          implementerProfile: selected.profile,
        }),
      ]);
    },
  );
});
