import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import { normalizeCustomCommand } from '../../../core/config/custom-commands.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import {
  customRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from '../../runners/custom-trust.js';
import { prepareCustomRunnerAdmission } from '../../runners/custom-admission.js';
import type { RunnerGate } from '../../runners/prepared-execution.js';
import type { CustomRunnerRuntimePort } from '../../runners/types.js';
import { createConfiguredCustomImplementer } from '../../implementers/command-invoke.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createStagedProject } from '../approval/staged-project.js';
import { applyChangedFiles } from './apply-changed-files.js';
import { runImplementation } from './run-implementation.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) cleanupTempDir(directory);
});

function setupProject(prefix: string): { projectDir: string; stateDir: string } {
  const projectDir = createTempDir(`${prefix}-project`);
  const stateDir = createTempDir(`${prefix}-state`);
  directories.push(projectDir, stateDir);
  createTestGitRepo(projectDir);
  return { projectDir, stateDir };
}

function configuredImplementer(
  contract: 'output' | 'direct',
  program: string,
): ConfiguredCustomRunner {
  return {
    source: 'configured',
    command: normalizeCustomCommand(`t028-${contract}-workflow`, {
      label: `T028 ${contract} workflow`,
      contract,
      executable: process.execPath,
      argv: ['-e', program],
      env: ['T028_ALLOWED_VALUE'],
    }),
  };
}

function runtimeFor(
  input: Readonly<{
    projectDir: string;
    stateDir: string;
    sourceEnv: NodeJS.ProcessEnv;
    createStage?: CustomRunnerRuntimePort['createStage'];
  }>,
): CustomRunnerRuntimePort {
  return {
    sessionId: 't028-session-must-not-reach-child',
    authorizationProjectDir: input.projectDir,
    sourceEnv: input.sourceEnv,
    authorizationPathEnv: process.env.PATH ?? '',
    ...(process.env.PATHEXT === undefined ? {} : { authorizationPathExt: process.env.PATHEXT }),
    createStage:
      input.createStage ?? (async (sourceProjectDir) => createStagedProject(sourceProjectDir)),
    admission: { interaction: 'headless', allowRepoRunners: true, stateDir: input.stateDir },
    cleanupStaleArtifactReviews: async () => {},
    beginDeclaredArtifactReview: async () => {
      throw new Error('Configured implementer must not begin planner artifact review.');
    },
  };
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
    preparationId: 'run-implementation-test',
    command: { kind: 'configured-custom', invocation: admission.invocation },
  } satisfies RunnerGate;
  return createConfiguredCustomImplementer({
    runtime,
    admission: gate.command.invocation,
  });
}

function setupDirectScenario(approval: 'approved' | 'rejected'): {
  projectDir: string;
  stateDir: string;
  outsideDir: string;
} {
  const { projectDir, stateDir } = setupProject(`t028-direct-${approval}`);
  const outsideDir = createTempDir(`t028-direct-${approval}-outside`);
  directories.push(outsideDir);
  return { projectDir, stateDir, outsideDir };
}

async function runIsolatedDirectScenario(approval: 'approved' | 'rejected'): Promise<void> {
  const { projectDir, stateDir, outsideDir } = setupDirectScenario(approval);
  const outsideSentinel = join(outsideDir, 'child-can-reach-host');
  const task = makeTask({
    id: approval === 'approved' ? 'T029' : 'T030',
    file: 'src/direct.ts',
    action: 'create',
  });
  const state = makeImplState([task]);
  let nestedStageCalls = 0;
  const runtime = runtimeFor({
    projectDir,
    stateDir,
    sourceEnv: {
      T028_ALLOWED_VALUE: 'runtime-source-only',
      T028_UNDECLARED_SECRET: 'must-not-reach-child',
    },
    createStage: async () => {
      nestedStageCalls += 1;
      throw new Error('Direct custom implementers must use the workflow outer stage');
    },
  });
  const program = [
    "const fs = require('node:fs');",
    "const prompt = fs.readFileSync(0, 'utf8');",
    "fs.mkdirSync('src', { recursive: true });",
    `fs.writeFileSync(${JSON.stringify(outsideSentinel)}, 'outside-stage-reachable');`,
    'const lines = [',
    "  '// cwd:' + process.cwd(),",
    "  '// allowed:' + (process.env.T028_ALLOWED_VALUE ?? 'absent'),",
    "  '// undeclared:' + (process.env.T028_UNDECLARED_SECRET ?? 'absent'),",
    "  '// session-in-prompt:' + prompt.includes('t028-session-must-not-reach-child'),",
    "  'export const direct = true;',",
    '];',
    "fs.writeFileSync('src/direct.ts', lines.join('\\n') + '\\n');",
  ].join('');
  const implementer = await createPreparedImplementer(
    configuredImplementer('direct', program),
    runtime,
  );
  const { callbacks } = makeCallbacks({
    onTieredApproval: vi
      .fn()
      .mockResolvedValue(
        approval === 'approved'
          ? { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: 'reviewed' }
          : { decision: 'deny', reason: 'not approved' },
      ),
  });
  const config = makeNoValidationConfig({
    approval: {
      enabled: true,
      feedRejectionsToPlanner: true,
      tiers: { write_in_scope: 'confirm' },
    },
  });
  const wctx = makeWctx({
    projectDir,
    sessionId: 't028-session-must-not-reach-child',
    config,
    callbacks,
    implementer,
  });

  const implementation = await runImplementation({
    wctx,
    task,
    state,
    taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
    setTrackedState: vi.fn(),
    recordApprovalDenial: vi.fn(),
  });

  expect(implementation.implResult.success).toBe(true);
  expect(implementation.usesStaging).toBe(true);
  expect(nestedStageCalls).toBe(0);
  expect(implementation.staged).toBeDefined();
  const staged = implementation.staged;
  if (staged === undefined) throw new Error('Direct implementation did not receive an outer stage');
  expect(staged.sandboxEnv.T028_ALLOWED_VALUE).toBeUndefined();
  const stagedOutput = readFileSync(join(staged.projectDir, 'src', 'direct.ts'), 'utf8');
  expect(stagedOutput).toContain(`// cwd:${realpathSync(staged.projectDir)}`);
  expect(stagedOutput).toContain('// allowed:runtime-source-only');
  expect(stagedOutput).toContain('// undeclared:absent');
  expect(stagedOutput).toContain('// session-in-prompt:false');
  expect(readFileSync(outsideSentinel, 'utf8')).toBe('outside-stage-reachable');
  expect(existsSync(join(projectDir, 'src', 'direct.ts'))).toBe(false);

  const applied = await applyChangedFiles({
    wctx,
    task,
    state: implementation.state,
    staged,
    usesStaging: implementation.usesStaging,
    preApplyApprovedFiles: implementation.preApplyApprovedFiles,
    taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
    recordApprovalDenial: vi.fn(),
    handleConflict: async (currentState) => currentState,
  });

  expect(applied.proceed).toBe(approval === 'approved');
  expect(existsSync(staged.projectDir)).toBe(false);
  expect(existsSync(join(projectDir, 'src', 'direct.ts'))).toBe(approval === 'approved');
}

describe('runImplementation configured custom contracts', () => {
  it('discards output-child writes while applying parsed output to the real target without stage env or session leakage', async () => {
    const { projectDir, stateDir } = setupProject('t028-output-workflow');
    const task = makeTask({ id: 'T028', file: 'src/output.ts', action: 'create' });
    const state = makeImplState([task]);
    const childStages: string[] = [];
    const runtime = runtimeFor({
      projectDir,
      stateDir,
      sourceEnv: {
        T028_ALLOWED_VALUE: 'runtime-source-only',
        T028_UNDECLARED_SECRET: 'must-not-reach-child',
      },
      createStage: async (sourceProjectDir) => {
        const stage = await createStagedProject(sourceProjectDir);
        childStages.push(realpathSync(stage.projectDir));
        stage.sandboxEnv.T028_ALLOWED_VALUE = 'stage-sandbox-only';
        return stage;
      },
    });
    const program = [
      "const fs = require('node:fs');",
      "const prompt = fs.readFileSync(0, 'utf8');",
      "fs.writeFileSync('output-child-only.txt', 'discard');",
      'const lines = [',
      "  '// cwd:' + process.cwd(),",
      "  '// allowed:' + (process.env.T028_ALLOWED_VALUE ?? 'absent'),",
      "  '// sandbox:' + (process.env.T028_STAGE_ONLY ?? 'absent'),",
      "  '// undeclared:' + (process.env.T028_UNDECLARED_SECRET ?? 'absent'),",
      "  '// session-in-prompt:' + prompt.includes('t028-session-must-not-reach-child'),",
      "  'export const output = true;',",
      '];',
      "process.stdout.write('```ts\\n' + lines.join('\\n') + '\\n```\\n');",
    ].join('');
    const implementer = await createPreparedImplementer(
      configuredImplementer('output', program),
      runtime,
    );
    const wctx = makeWctx({
      projectDir,
      sessionId: 't028-session-must-not-reach-child',
      config: makeNoValidationConfig(),
      implementer,
    });

    const result = await runImplementation({
      wctx,
      task,
      state,
      taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
    });

    expect(result.implResult.success).toBe(true);
    expect(result.usesStaging).toBe(false);
    expect(result.staged).toBeUndefined();
    expect(childStages).toHaveLength(1);
    const childStage = childStages[0];
    if (childStage === undefined) throw new Error('Output child stage was not created');
    const applied = readFileSync(join(projectDir, 'src', 'output.ts'), 'utf8');
    expect(applied).toContain(`// cwd:${childStage}`);
    expect(applied).toContain('// allowed:***REDACTED***');
    expect(applied).not.toContain('runtime-source-only');
    expect(applied).toContain('// sandbox:absent');
    expect(applied).toContain('// undeclared:absent');
    expect(applied).toContain('// session-in-prompt:false');
    expect(existsSync(join(projectDir, 'output-child-only.txt'))).toBe(false);
    expect(existsSync(childStage)).toBe(false);
  });

  it('promotes an approved direct custom-runner outer-stage diff', {
    timeout: 30_000,
  }, async () => {
    await runIsolatedDirectScenario('approved');
  });

  it('discards a rejected direct custom-runner outer-stage diff', { timeout: 30_000 }, async () => {
    await runIsolatedDirectScenario('rejected');
  });
});
