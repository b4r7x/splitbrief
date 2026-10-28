import { plainUserMessage } from '../../../core/types/user-input.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import { normalizeCustomCommand } from '../../../core/config/custom-commands.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import type { WorkflowState, ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { recordedApiCreatedPaths } from '../evidence/task.js';
import { makeImplementerRetryInvoker } from '../escalation/make-implementer-retry-invoker.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { raiseApiApplyRecovery } from '../evidence/persistence.js';
import { createQueueHandler, enqueueUserMessage } from '../queue/submit.js';
import { clearPendingQueue } from '../queue/clear.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeCopyingIsolation,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { createContinuationHolder } from '../continuation.js';
import type { AttemptWorkspace, RunIsolation } from '../isolation/types.js';
import type { Implementer, ImplementerOptions, RetryOptions } from '../../implementers/types.js';
import { GIT_EMPTY_TREE_HASH } from '../../../lib/git/refs.js';
import { createSteeringPort, type SteerOutcome } from '../../calls/steering.js';
import { createWriteSequencer } from '../serial-executor.js';
import type { InvokeOpts } from '../../implementers/types.js';
import {
  customRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from '../../runners/custom-trust.js';
import { prepareCustomRunnerAdmission } from '../../runners/custom-admission.js';
import type { RunnerGate } from '../../runners/prepared-execution.js';
import type { CustomRunnerRuntimePort } from '../../runners/types.js';
import { createConfiguredCustomImplementer } from '../../implementers/command-invoke.js';
import { createImplementerBase } from '../../implementers/pipeline/run.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { fixBriefDescription, type FixFinding } from '../../../core/review/fix-task.js';
import {
  captureProjectFileHashes,
  getChangedFilesSinceSnapshot,
  getChangedFilesSnapshot,
} from '../approval/file-snapshots/capture.js';
import { createStagedProject } from '../approval/staged-project.js';
import { gateAttemptChanges } from './attempt-gate.js';
import { runImplementation } from './run-implementation.js';
import type { StreamingSink } from './streaming-feed.js';
import { attachedMessage } from '#testing/helpers/user-message.js';

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) cleanupTempDir(directory);
});

function setupProject(prefix: string): { projectDir: string; stateDir: string } {
  // A child's cwd is the real path; on macOS the temp directory is a /var alias of /private/var.
  const projectDir = realpathSync(createTempDir(`${prefix}-project`));
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
      input.createStage ??
      (async (sourceProjectDir) => createStagedProject({ projectDir: sourceProjectDir })),
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
  ensureSessionDir(projectDir, 't028-session-must-not-reach-child');
  const outsideSentinel = join(outsideDir, 'child-can-reach-host');
  const task = makeTask({
    id: approval === 'approved' ? 'T029' : 'T030',
    suggestedFiles: ['.env.local'],
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
    "  '// session-id-outside-workspace-path:' + prompt.split(process.cwd()).join('').includes('t028-session-must-not-reach-child'),",
    "  'export const direct = true;',",
    '];',
    "fs.writeFileSync('.env.local', lines.join('\\n') + '\\n');",
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
      feedRejectionsToPlanner: true,
    },
  });
  const wctx = makeWctx({
    projectDir,
    sessionId: 't028-session-must-not-reach-child',
    isolation: makeCopyingIsolation({ projectDir, sessionId: 't028-session-must-not-reach-child' }),
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
  expect(nestedStageCalls).toBe(0);
  expect(implementation.workspace).toBeDefined();
  const workspace = implementation.workspace;
  if (workspace === undefined)
    throw new Error('Direct implementation did not receive an outer stage');
  expect(workspace.sandboxEnv.T028_ALLOWED_VALUE).toBeUndefined();
  const stagedOutput = readFileSync(join(workspace.projectDir, '.env.local'), 'utf8');
  expect(stagedOutput).toContain(`// cwd:${realpathSync(workspace.projectDir)}`);
  expect(stagedOutput).toContain('// allowed:runtime-source-only');
  expect(stagedOutput).toContain('// undeclared:absent');
  // The confinement rule names the workspace path, which lives under the session
  // directory; the session id must not travel anywhere else in the prompt.
  expect(stagedOutput).toContain('// session-id-outside-workspace-path:false');
  expect(readFileSync(outsideSentinel, 'utf8')).toBe('outside-stage-reachable');
  expect(existsSync(join(projectDir, '.env.local'))).toBe(false);

  const gate = await gateAttemptChanges({
    wctx,
    task,
    phase: implementation.state.phase,
    workspace,
    preApprovedFiles: implementation.preApplyApprovedFiles,
    dependsOnFiles: [],
    onApproved: vi.fn(),
  });

  expect(gate.outcome).toBe(approval === 'approved' ? 'allow' : 'denied');
  expect(existsSync(workspace.projectDir)).toBe(true);
  expect(existsSync(join(projectDir, '.env.local'))).toBe(false);
  await wctx.isolation.dispose();
  expect(existsSync(join(workspace.projectDir, '.env.local'))).toBe(approval === 'approved');
}

describe('runImplementation configured custom contracts', () => {
  it.each(['approved', 'rejected'] as const)(
    'gates an extracted protected write before application when %s and prompts only once',
    async (approval) => {
      const { projectDir } = setupProject(`extracted-protected-${approval}`);
      const sessionId = 'sess-extracted-protected';
      ensureSessionDir(projectDir, sessionId);
      const task = makeTask({ suggestedFiles: ['.env.local'], action: 'create' });
      const onTieredApproval = vi
        .fn()
        .mockResolvedValue(
          approval === 'approved'
            ? { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: 'reviewed' }
            : { decision: 'deny', reason: 'no' },
        );
      const wctx = makeWctx({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: makeNoValidationConfig({
          approval: { feedRejectionsToPlanner: false },
        }),
        callbacks: makeCallbacks({ onTieredApproval }).callbacks,
        implementer: createImplementerBase(
          makeBaseConfig({
            invoke: async () =>
              makeRunnerCallResult({ status: 'completed', text: '```text\nVALUE=2\n```' }),
          }),
        ),
      });
      try {
        const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
        const result = await runImplementation({
          wctx,
          task,
          state: makeImplState([task]),
          taskStartSnapshot,
          setTrackedState: vi.fn(),
          recordApprovalDenial: vi.fn(),
        });
        expect(onTieredApproval).toHaveBeenCalledTimes(1);
        expect(result.preApplyApprovalDenied).toBe(approval === 'rejected');
        expect(result.preApplyApprovedFiles).toEqual(approval === 'approved' ? ['.env.local'] : []);
        expect(existsSync(join(projectDir, '.env.local'))).toBe(false);
        expect(existsSync(join(result.workspace.projectDir, '.env.local'))).toBe(
          approval === 'approved',
        );
        if (approval === 'approved') {
          expect(result.implResult.success).toBe(true);
          const gate = await gateAttemptChanges({
            wctx,
            task,
            phase: result.state.phase,
            workspace: result.workspace,
            preApprovedFiles: result.preApplyApprovedFiles,
            dependsOnFiles: [],
            onApproved: vi.fn(),
          });
          expect(gate).toMatchObject({ outcome: 'allow', approvedFiles: ['.env.local'] });
          expect(readFileSync(join(result.workspace.projectDir, '.env.local'), 'utf8')).toContain(
            'VALUE=2',
          );
          expect(existsSync(join(projectDir, '.env.local'))).toBe(false);
          expect(onTieredApproval).toHaveBeenCalledTimes(1);
        }
      } finally {
        await wctx.isolation.dispose();
      }
    },
  );

  it("an extracted-code writer's first attempt writes into the run workspace", async () => {
    const { projectDir } = setupProject('extracted-first-attempt');
    const sessionId = 'sess-extracted-first';
    ensureSessionDir(projectDir, sessionId);
    const file = 'src/value.ts';
    const original = 'export const value = 1;\n';
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, file), original);
    const task = makeTask({ suggestedFiles: [file], action: 'modify' });
    const receivedDirs: string[] = [];
    const wctx = makeWctx({
      projectDir,
      sessionId,
      isolation: makeCopyingIsolation({ projectDir, sessionId }),
      implementer: makeImplementer({
        capabilities: { writesFiles: 'extracted-code' },
        implement: async (opts: ImplementerOptions) => {
          receivedDirs.push(opts.projectDir);
          expect(opts.lineageAttempt).toBe(1);
          writeFileSync(join(opts.projectDir, file), 'export const value = 2;\n');
          return { success: true, output: 'updated value' };
        },
      }),
    });

    try {
      const result = await runImplementation({
        wctx,
        task,
        state: makeImplState([task]),
        taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
        setTrackedState: vi.fn(),
        recordApprovalDenial: vi.fn(),
      });

      expect(result.workspace).toBeDefined();
      expect(receivedDirs).toEqual([result.workspace?.projectDir]);
      expect(receivedDirs[0]).not.toBe(projectDir);
      expect(readFileSync(join(projectDir, file), 'utf8')).toBe(original);
      if (result.workspace === undefined) throw new Error('Missing run workspace');
      expect(readFileSync(join(result.workspace.projectDir, file), 'utf8')).toBe(
        'export const value = 2;\n',
      );
    } finally {
      await wctx.isolation.dispose();
    }
  });

  it('discards output-child writes while applying parsed output to the run workspace without stage env or session leakage', async () => {
    const { projectDir, stateDir } = setupProject('t028-output-workflow');
    ensureSessionDir(projectDir, 't028-session-must-not-reach-child');
    const task = makeTask({ id: 'T028', suggestedFiles: ['src/output.ts'], action: 'create' });
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
        const stage = await createStagedProject({ projectDir: sourceProjectDir });
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
      isolation: makeCopyingIsolation({
        projectDir,
        sessionId: 't028-session-must-not-reach-child',
      }),
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
    expect(result.workspace.projectDir).not.toBe(projectDir);
    expect(childStages).toHaveLength(1);
    const childStage = childStages[0];
    if (childStage === undefined) throw new Error('Output child stage was not created');
    const applied = readFileSync(join(result.workspace.projectDir, 'src', 'output.ts'), 'utf8');
    expect(applied).toContain(`// cwd:${childStage}`);
    expect(applied).toContain('// allowed:***REDACTED***');
    expect(applied).not.toContain('runtime-source-only');
    expect(applied).toContain('// sandbox:absent');
    expect(applied).toContain('// undeclared:absent');
    expect(applied).toContain('// session-in-prompt:false');
    expect(existsSync(join(projectDir, 'output-child-only.txt'))).toBe(false);
    expect(existsSync(join(projectDir, 'src/output.ts'))).toBe(false);
    expect(existsSync(join(result.workspace.projectDir, 'output-child-only.txt'))).toBe(false);
    expect(existsSync(childStage)).toBe(false);
    await wctx.isolation.dispose();
  });

  it('keeps an approved direct custom-runner outer-stage diff in the run workspace only', {
    timeout: 30_000,
  }, async () => {
    await runIsolatedDirectScenario('approved');
  });

  it('discards a rejected direct custom-runner outer-stage diff', { timeout: 30_000 }, async () => {
    await runIsolatedDirectScenario('rejected');
  });
});

describe('runImplementation workspace continuation', () => {
  async function capturedResume(
    seed:
      | {
          partial?: string;
          steer?: ReturnType<typeof plainUserMessage>;
          attempt?: number;
          keepWorkspace?: true;
        }
      | undefined,
    stateOverrides?: Partial<WorkflowState>,
  ): Promise<boolean | undefined> {
    const { projectDir } = setupProject('reseed');
    ensureSessionDir(projectDir, 'reseed-session');
    const task = makeTask({ id: 'T040', suggestedFiles: ['src/reseed.ts'], action: 'create' });
    const state = makeImplState([task], stateOverrides);
    const resumeArgs: Array<boolean | undefined> = [];
    const sharedIsolation = makeCopyingIsolation({ projectDir, sessionId: 'reseed-session' });
    const isolation: RunIsolation = {
      ...sharedIsolation,
      acquire: async (opts) => {
        resumeArgs.push(opts.resume);
        return sharedIsolation.acquire(opts);
      },
    };
    const continuation =
      seed === undefined
        ? undefined
        : createContinuationHolder({
            step: { kind: 'brief', taskId: task.id, attempt: seed.attempt ?? 0 },
            ...(seed.partial !== undefined && { partial: seed.partial }),
            ...(seed.steer !== undefined && { steer: seed.steer }),
            ...(seed.keepWorkspace === true && { keepWorkspace: true }),
          });
    const wctx = makeWctx({
      projectDir,
      sessionId: 'reseed-session',
      implementer: makeImplementer({ capabilities: { writesFiles: 'direct' } }),
      isolation,
      ...(continuation !== undefined && { continuation }),
    });

    await runImplementation({
      wctx,
      task,
      state,
      taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
    });

    await isolation.dispose();
    expect(resumeArgs).toHaveLength(1);
    return resumeArgs[0];
  }

  it('starts an attempt without resuming when it carries no continuation seed', async () => {
    expect(await capturedResume(undefined)).toBe(false);
  });

  it('starts an attempt without resuming when a correction alone continues the brief', async () => {
    expect(await capturedResume({ steer: plainUserMessage('use the smaller helper') })).toBe(false);
  });

  it('keeps the worktree for a genuine mid-step park continuation', async () => {
    // A genuine park carries what `resumeContinuation` records: the partial and the keep flag.
    expect(await capturedResume({ partial: 'half a brief', keepWorkspace: true })).toBe(true);
  });

  it("does not resume when a prior attempt's partial no longer matches the reset attempt", async () => {
    expect(await capturedResume({ partial: 'half a brief', attempt: 2 })).toBe(false);
  });
});

describe('runImplementation seat trouble', () => {
  it('retries a transient failure without counting an attempt and keeps the discarded usage', async () => {
    const { projectDir } = setupProject('seat-retry');
    const sessionId = 'seat-retry-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T060', suggestedFiles: ['src/retry.ts'], action: 'create' });
    const state = makeImplState([task]);
    const firstUsage = { inputTokens: 7, outputTokens: 3 };
    const secondUsage = { inputTokens: 2, outputTokens: 1 };
    const implement = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        output: 'busy',
        error: 'HTTP 503 Service Unavailable',
        outcome: 'non-zero-exit',
        usage: firstUsage,
      })
      .mockResolvedValueOnce({ success: true, output: '', usage: secondUsage });
    const implementer = makeImplementer({ implement });
    const tracked: WorkflowState[] = [];
    const wctx = makeWctx({ projectDir, sessionId, implementer });
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);

    vi.useFakeTimers();
    const pending = runImplementation({
      wctx,
      task,
      state,
      taskStartSnapshot,
      setTrackedState: (next) => tracked.push(next),
      recordApprovalDenial: vi.fn(),
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled) {
      await vi.advanceTimersByTimeAsync(vi.getTimerCount() === 0 ? 1 : 2_000);
    }
    const result = await pending;

    expect(implement).toHaveBeenCalledTimes(2);
    expect(result.state.attempt).toBe(state.attempt);
    // The attempt a retry replaces keeps its usage with the run.
    expect(tracked.at(-1)?.tokenUsage.implementerInput).toBe(firstUsage.inputTokens);
    expect(tracked.at(-1)?.tokenUsage.implementerOutput).toBe(firstUsage.outputTokens);
    // The surviving attempt's own usage comes back on the result.
    expect(result.implResult.usage).toEqual(secondUsage);
  });

  it('waits out a near reset holding the BUILD profile the brief runs on', async () => {
    const { projectDir } = setupProject('seat-wait-profile');
    const sessionId = 'seat-wait-profile-session';
    ensureSessionDir(projectDir, sessionId);
    const ref = { projectDir, sessionId };
    const task = makeTask({ id: 'T061', suggestedFiles: ['src/wait.ts'], action: 'create' });
    const state = makeImplState([task]);
    saveState(ref, state);
    const claudeCode = { kind: 'cli', tool: 'claude-code' } as const;
    const implement = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: "You've hit your usage limit. Try again in 5 minutes.",
      })
      .mockResolvedValueOnce({ success: true, output: '' });
    const wctx = makeWctx({
      projectDir,
      sessionId,
      implementer: makeImplementer({ implement }),
      config: makeNoValidationConfig({
        implementer: claudeCode,
        implementerProfiles: {
          default: 'small',
          profiles: { big: claudeCode, small: { kind: 'cli', tool: 'codex' } },
        },
      }),
      implementerProfile: 'big',
    });
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);

    vi.useFakeTimers();
    const pending = runImplementation({
      wctx,
      task,
      state,
      taskStartSnapshot,
      setTrackedState: () => {},
      recordApprovalDenial: vi.fn(),
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let wait: WorkflowState['seatWait'];
    while (!settled) {
      wait ??= loadState(ref)?.seatWait;
      await vi.advanceTimersByTimeAsync(vi.getTimerCount() === 0 ? 1 : 30_000);
    }
    await pending;

    expect(implement).toHaveBeenCalledTimes(2);
    expect(wait?.holds).toEqual({ tool: 'claude-code', kind: 'cli', profile: 'big' });
  });
});

describe('runImplementation correction at a stop', () => {
  const correction = 'Keep the helper in src/retry.ts.';

  function stoppingWctx(input: {
    projectDir: string;
    sessionId: string;
    implementer: Implementer;
    signal?: AbortSignal;
  }) {
    const abort: { call: (() => void) | null } = { call: null };
    const wctx = makeWctx({
      projectDir: input.projectDir,
      sessionId: input.sessionId,
      implementer: input.implementer,
      callbacks: makeCallbacks({ onContinuationNeeded: async () => plainUserMessage(correction) })
        .callbacks,
      sinks: {
        setAbortHandler: (handler) => {
          abort.call = handler;
        },
        setQueueHandler: () => {},
      },
      ...(input.signal !== undefined && { signal: input.signal }),
    });
    return { wctx, abort };
  }

  const stopped = () => new DOMException('The operation was aborted', 'AbortError');

  it.each(['throw', 'return'] as const)(
    'counts completed calls once after an interrupted correction exits by %s and continues',
    async (exit) => {
      const { projectDir } = setupProject(`correction-interrupted-${exit}`);
      const ref = { projectDir, sessionId: `correction-interrupted-${exit}` };
      ensureSessionDir(projectDir, ref.sessionId);
      const task = makeTask({ id: 'T063', action: 'create', suggestedFiles: ['src/retry.ts'] });
      const state = makeImplState([task]);
      saveState(ref, state);
      const { bus } = makeBusRecorder();
      const holder: { abort: { call: (() => void) | null } } = { abort: { call: null } };
      const calls: ImplementerOptions[] = [];
      const implementer = makeImplementer({
        implement: async (call) => {
          calls.push(call);
          if (calls.length <= 2) {
            enqueueUserMessage({
              ...ref,
              state,
              bus,
              phase: 'implementing',
              message: plainUserMessage(`correction ${calls.length}`),
            });
            return {
              success: true,
              output: 'completed',
              usage:
                calls.length === 1
                  ? { inputTokens: 10, outputTokens: 4 }
                  : { inputTokens: 7, outputTokens: 5 },
            };
          }
          if (calls.length === 3) {
            call.onOutput?.('partial correction');
            holder.abort.call?.();
            if (exit === 'throw') throw stopped();
            return { success: false, output: '', usage: { inputTokens: 2, outputTokens: 1 } };
          }
          return { success: true, output: 'continued', usage: { inputTokens: 3, outputTokens: 2 } };
        },
      });
      const { wctx, abort } = stoppingWctx({ ...ref, implementer });
      holder.abort = abort;
      const continuation = vi.fn(async () => {
        expect(loadState(ref)?.tokenUsage.implementerInput).toBe(17);
        return plainUserMessage(correction);
      });
      wctx.bus = bus;
      wctx.callbacks.onContinuationNeeded = continuation;

      try {
        const result = await runImplementation({
          wctx,
          task,
          state,
          taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
          setTrackedState: vi.fn(),
          recordApprovalDenial: vi.fn(),
        });
        expect(calls).toHaveLength(4);
        expect(continuation).toHaveBeenCalledTimes(1);
        expect(calls[3]?.continuation?.partial).toContain('partial correction');
        expect(calls[3]?.continuation?.steer).toContain(correction);
        expect(result.state.attempt).toBe(state.attempt);
        expect(result.implResult.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
        const accounted = addUsageAndSave(
          { ...ref, bus },
          result.state,
          'implementer',
          result.implResult.usage,
        );
        expect(accounted.tokenUsage).toMatchObject({
          implementerInput: 20,
          implementerOutput: 11,
        });
        expect(loadState(ref)?.tokenUsage).toEqual(accounted.tokenUsage);
      } finally {
        await wctx.isolation.dispose();
      }
    },
  );

  it('persists the correction when it is given, beside usage written after it', async () => {
    const { projectDir } = setupProject('stop-correction-usage');
    const sessionId = 'stop-correction-usage-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T061', suggestedFiles: ['src/retry.ts'], action: 'create' });
    const discardedUsage = { inputTokens: 7, outputTokens: 3 };
    const holder: { abort: { call: (() => void) | null } } = { abort: { call: null } };
    const implement = vi
      .fn()
      .mockImplementationOnce(async () => {
        holder.abort.call?.();
        throw stopped();
      })
      .mockResolvedValueOnce({
        success: false,
        output: 'busy',
        error: 'HTTP 503 Service Unavailable',
        outcome: 'non-zero-exit',
        usage: discardedUsage,
      })
      .mockResolvedValueOnce({ success: true, output: '' });
    const { wctx, abort } = stoppingWctx({
      projectDir,
      sessionId,
      implementer: makeImplementer({ implement }),
    });
    holder.abort = abort;
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);

    vi.useFakeTimers();
    const pending = runImplementation({
      wctx,
      task,
      state: makeImplState([task]),
      taskStartSnapshot,
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled) {
      await vi.advanceTimersByTimeAsync(vi.getTimerCount() === 0 ? 1 : 2_000);
    }
    vi.useRealTimers();
    const result = await pending;

    expect(implement).toHaveBeenCalledTimes(3);
    const durable = loadState({ projectDir, sessionId });
    for (const saved of [result.state, durable]) {
      expect(saved?.lineages?.T061?.corrections).toEqual([correction]);
      expect(saved?.tokenUsage.implementerInput).toBe(discardedUsage.inputTokens);
    }
  });

  it('keeps the correction when the run stops again before the brief returns', async () => {
    const { projectDir } = setupProject('stop-correction-abort');
    const sessionId = 'stop-correction-abort-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T062', suggestedFiles: ['src/retry.ts'], action: 'create' });
    const run = new AbortController();
    const holder: { abort: { call: (() => void) | null } } = { abort: { call: null } };
    const implement = vi
      .fn()
      .mockImplementationOnce(async () => {
        holder.abort.call?.();
        throw stopped();
      })
      .mockImplementationOnce(async () => {
        run.abort();
        throw stopped();
      });
    const { wctx, abort } = stoppingWctx({
      projectDir,
      sessionId,
      implementer: makeImplementer({ implement }),
      signal: run.signal,
    });
    holder.abort = abort;

    await expect(
      runImplementation({
        wctx,
        task,
        state: makeImplState([task]),
        taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
        setTrackedState: vi.fn(),
        recordApprovalDenial: vi.fn(),
      }),
    ).rejects.toThrow();

    expect(implement).toHaveBeenCalledTimes(2);
    expect(loadState({ projectDir, sessionId })?.lineages?.T062?.corrections).toEqual([correction]);
  });
});

describe('runImplementation continuation note', () => {
  async function taskStartBaseline(projectDir: string): Promise<ChangedFilesSnapshot> {
    return {
      ...(await getChangedFilesSnapshot(projectDir)),
      baselineFileHashes: await captureProjectFileHashes(projectDir),
    };
  }

  async function workspaceBaseline(
    projectDir: string,
    baselineFileHashes: Record<string, string | null>,
  ): Promise<ChangedFilesSnapshot> {
    return { ...(await getChangedFilesSnapshot(projectDir)), baselineFileHashes };
  }

  function noteIsolation(projectDir: string, snapshot: ChangedFilesSnapshot): RunIsolation {
    return {
      open: async () => ({ kind: 'worktree', projectDir, head: null, keptFiles: [] }),
      acquire: async () => ({
        projectDir,
        sandboxEnv: {},
        snapshot,
        targetBaseline: undefined,
        changeDetection: 'file-hashes',
        changedFiles: () => getChangedFilesSinceSnapshot(projectDir, snapshot),
        cleanup: () => {},
        revert: vi.fn(),
      }),
      dispose: async () => {},
    };
  }

  async function runNote(
    projectDir: string,
    sessionId: string,
    task: Task,
    taskStartSnapshot: ChangedFilesSnapshot,
    workspaceSnapshot: ChangedFilesSnapshot,
  ): Promise<ImplementerOptions['continuation']> {
    const implementer = makeImplementer({ capabilities: { writesFiles: 'direct' } });
    const continuation = createContinuationHolder({
      step: { kind: 'brief', taskId: task.id, attempt: 0 },
      steer: plainUserMessage('use the registry'),
    });
    await runImplementation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        implementer,
        isolation: noteIsolation(projectDir, workspaceSnapshot),
        continuation,
      }),
      task,
      state: makeImplState([task]),
      taskStartSnapshot,
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
    });
    return vi.mocked(implementer.implement).mock.calls[0]?.[0].continuation;
  }

  it('names the declared files that changed since the brief started', async () => {
    const { projectDir } = setupProject('reseed-note');
    ensureSessionDir(projectDir, 'reseed-note-session');
    const task = makeTask({ id: 'T041', suggestedFiles: ['src/reseed.ts'], action: 'create' });
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    // Written after the task-start snapshot and before the call, as a reset brief finds it.
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/reseed.ts'), 'export const reseed = 1;\n');
    const implementer = makeImplementer({ capabilities: { writesFiles: 'direct' } });
    const isolation: RunIsolation = {
      open: async () => ({ kind: 'worktree', projectDir, head: null, keptFiles: [] }),
      acquire: async () => {
        const snapshot = await getChangedFilesSnapshot(projectDir);
        return {
          projectDir,
          sandboxEnv: {},
          snapshot,
          targetBaseline: undefined,
          changeDetection: 'file-hashes',
          changedFiles: () => getChangedFilesSinceSnapshot(projectDir, snapshot),
          cleanup: () => {},
          revert: vi.fn(),
        };
      },
      dispose: async () => {},
    };
    const continuation = createContinuationHolder({
      step: { kind: 'brief', taskId: task.id, attempt: 0 },
      steer: plainUserMessage('use the registry'),
    });
    const wctx = makeWctx({
      projectDir,
      sessionId: 'reseed-note-session',
      implementer,
      isolation,
      continuation,
    });

    await runImplementation({
      wctx,
      task,
      state: makeImplState([task]),
      taskStartSnapshot,
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
    });

    expect(vi.mocked(implementer.implement).mock.calls[0]?.[0].continuation).toEqual({
      steer: 'use the registry',
      extra:
        'These declared files changed since this brief started (an earlier attempt of this brief left them): src/reseed.ts',
    });
  });

  it('ignores a declared file an earlier task changed before the brief started', async () => {
    const { projectDir } = setupProject('reseed-note-earlier');
    const sessionId = 'reseed-note-earlier-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T042', suggestedFiles: ['src/reseed.ts'], action: 'modify' });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/reseed.ts'), 'export const reseed = 1;\n');
    const taskStartSnapshot = await taskStartBaseline(projectDir);
    const workspaceSnapshot = await workspaceBaseline(projectDir, {});

    const continuation = await runNote(
      projectDir,
      sessionId,
      task,
      taskStartSnapshot,
      workspaceSnapshot,
    );

    expect(continuation).toEqual({ steer: 'use the registry' });
  });

  it('lists a declared file a previous attempt changed after the brief started', async () => {
    const { projectDir } = setupProject('reseed-note-attempt');
    const sessionId = 'reseed-note-attempt-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T043', suggestedFiles: ['src/reseed.ts'], action: 'create' });
    const taskStartSnapshot = await taskStartBaseline(projectDir);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/reseed.ts'), 'export const reseed = 1;\n');
    const workspaceSnapshot = await workspaceBaseline(projectDir, {});

    const continuation = await runNote(
      projectDir,
      sessionId,
      task,
      taskStartSnapshot,
      workspaceSnapshot,
    );

    expect(continuation).toEqual({
      steer: 'use the registry',
      extra:
        'These declared files changed since this brief started (an earlier attempt of this brief left them): src/reseed.ts',
    });
  });

  it('names the files a cut attempt kept, in brief order, and lets the call change nothing', async () => {
    const { projectDir } = setupProject('reseed-note-kept');
    const sessionId = 'reseed-note-kept-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({
      id: 'T044',
      suggestedFiles: ['src/z-first.ts', 'src/a-second.ts'],
      action: 'create',
    });
    const taskStartSnapshot = await taskStartBaseline(projectDir);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/a-second.ts'), 'export const second = 2;\n');
    writeFileSync(join(projectDir, 'src/z-first.ts'), 'export const first = 1;\n');
    const implementer = makeImplementer({ capabilities: { writesFiles: 'direct' } });

    await runImplementation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        implementer,
        isolation: noteIsolation(projectDir, await workspaceBaseline(projectDir, {})),
        continuation: createContinuationHolder({
          step: { kind: 'brief', taskId: task.id, attempt: 0 },
          partial: 'half a brief',
        }),
      }),
      task,
      state: makeImplState([task]),
      taskStartSnapshot,
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
    });

    const call = vi.mocked(implementer.implement).mock.calls[0]?.[0];
    expect(call?.continuation?.kept).toEqual(['src/z-first.ts', 'src/a-second.ts']);
    expect(call?.allowNoChange).toBe(true);
  });
});

describe('runImplementation plan context', () => {
  it("puts the run's plan decisions and the task's criteria in the brief it dispatches", async () => {
    const { projectDir } = setupProject('plan-context');
    const sessionId = 'plan-context-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({
      id: 'T070',
      suggestedFiles: ['src/plan.ts'],
      action: 'create',
      criteria: ['C1'],
    });
    const prompts: string[] = [];
    const invoke = vi.fn().mockImplementation(async (call: { prompt: string }) => {
      prompts.push(call.prompt);
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));
    const state = makeImplState([task], {
      plan: {
        summary: 'Greet people by name',
        decisions: [{ text: 'PLAN-DECISION: keep the greeting in one module', taskId: null }],
        criteria: [{ id: 'C1', text: 'PLAN-CRITERION: a name gets a greeting', checkIds: [] }],
        checks: [],
        validation: null,
      },
    });

    await runImplementation({
      wctx: makeWctx({ projectDir, sessionId, implementer }),
      task,
      state,
      taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('PLAN-DECISION: keep the greeting in one module');
    expect(prompts[0]).toContain('C1: PLAN-CRITERION: a name gets a greeting');
  });
});

describe('runImplementation live preview', () => {
  // A Claude Code build call's text as it reached onOutput in a real run: two messages with tool
  // calls between them, and no line break where one message ends and the next begins.
  const CLAUDE_CODE_NARRATION = [
    "Using the brief's ste",
    'ps directly. I start with or',
    'ientation: the f',
    'ixture size',
    ', the two comment s',
    'ites, and the git state.',
    'The g',
    'allery file',
    ' already',
    ' car',
    'ries an',
    ' uncommitted change. I',
    ' check that',
    ' diff before I ed',
    'it it,',
    ' so my ed',
    'it does',
    ' not disturb it.',
  ];

  async function streamThrough(
    capabilities: Implementer['capabilities'],
    chunks: readonly string[],
  ): Promise<{ sink: StreamingSink; narration: string }> {
    const { projectDir } = setupProject('live-preview');
    ensureSessionDir(projectDir, 'live-preview-session');
    const task = makeTask({ id: 'T050', suggestedFiles: ['src/preview.ts'], action: 'modify' });
    const { bus, events } = makeBusRecorder();
    const isolation: RunIsolation = {
      open: async () => ({ kind: 'worktree', projectDir, head: null, keptFiles: [] }),
      acquire: async () => {
        const snapshot = await getChangedFilesSnapshot(projectDir);
        return {
          projectDir,
          sandboxEnv: {},
          snapshot,
          targetBaseline: undefined,
          changeDetection: 'file-hashes',
          changedFiles: () => getChangedFilesSinceSnapshot(projectDir, snapshot),
          cleanup: () => {},
          revert: vi.fn(),
        };
      },
      dispose: async () => {},
    };
    const implementer = makeImplementer({
      capabilities,
      implement: vi.fn(async ({ onOutput }: ImplementerOptions) => {
        for (const chunk of chunks) onOutput(chunk);
        return { success: true, output: '' };
      }),
    });
    const sink: StreamingSink = { start: vi.fn(), replaceLines: vi.fn(), stop: vi.fn() };

    await runImplementation({
      wctx: makeWctx({
        projectDir,
        sessionId: 'live-preview-session',
        bus,
        implementer,
        isolation,
      }),
      task,
      state: makeImplState([task]),
      taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
      streamingSink: sink,
    });

    const narration = events
      .flatMap((event) =>
        event.type === 'planner_text' && event.role === 'implementer' ? [event.text] : [],
      )
      .join('');
    return { sink, narration };
  }

  it("draws a direct writer's narration in its transcript rows only, never in the preview", async () => {
    const { sink, narration } = await streamThrough(
      { writesFiles: 'direct' },
      CLAUDE_CODE_NARRATION,
    );

    expect(narration).toBe(CLAUDE_CODE_NARRATION.join(''));
    expect(vi.mocked(sink.replaceLines).mock.calls).toEqual([]);
    expect(sink.start).not.toHaveBeenCalled();
  });

  it('previews the code an extractor streams', async () => {
    const { sink } = await streamThrough({ writesFiles: 'extracted-code' }, [
      '```ts\n',
      'export const preview = 1;\n',
      '```\n',
    ]);

    expect(sink.start).toHaveBeenCalledWith('T050');
    expect(vi.mocked(sink.replaceLines).mock.calls.at(-1)?.[0]).toEqual([
      '```ts',
      'export const preview = 1;',
      '```',
    ]);
  });
});

describe('runImplementation fix tasks', () => {
  it('dispatches a fix task with allowNoChange and the findings verbatim in its brief', async () => {
    const { projectDir } = setupProject('fix-task');
    const sessionId = 'fix-task-session';
    ensureSessionDir(projectDir, sessionId);
    const findings: FixFinding[] = [
      {
        id: 'F1',
        text: 'src/shared/widget.ts drops the error',
        acceptance: 'The error is rethrown',
      },
    ];
    const task = makeTask({
      id: 'T002',
      suggestedFiles: ['src/shared/widget.ts'],
      action: 'modify',
      description: fixBriefDescription(
        'Rethrow the widget error instead of swallowing it.',
        findings,
      ),
      fix: { cycle: 1, findings },
    });
    const prompts: string[] = [];
    const allowNoChange: boolean[] = [];
    const invoke = vi
      .fn()
      .mockImplementation(async (call: { prompt: string; allowNoChange?: boolean }) => {
        prompts.push(call.prompt);
        allowNoChange.push(call.allowNoChange === true);
        return makeRunnerCallResult({
          status: 'completed',
          text: 'nothing to change',
          usage: null,
        });
      });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    const result = await runImplementation({
      wctx: makeWctx({ projectDir, sessionId, implementer }),
      task,
      state: makeImplState([task]),
      taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
    });

    expect(result.implResult.success).toBe(true);
    expect(allowNoChange).toEqual([true]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('src/shared/widget.ts drops the error');
    expect(prompts[0]).toContain('Acceptance: The error is rethrown');
    expect(prompts[0]).toContain(
      'Evidence, ledger, review and session files are not your job; SPLITBRIEF records them. You may edit any ordinary project file the fix needs.',
    );
    expect(prompts[0]).toContain(
      'If no finding needs a code change, change nothing and report that.',
    );
  });
});

describe.each(['implementation', 'retry-invoker'] as const)(
  '%s file-bundle corrections',
  (caller) => {
    it('revokes every removed creation after multi-file correction failure recovery', async () => {
      const { projectDir } = setupProject(`bundle-rollback-${caller}`);
      const ref = { projectDir, sessionId: `bundle-rollback-${caller}` };
      ensureSessionDir(projectDir, ref.sessionId);
      const locked = join(projectDir, 'src/locked');
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o555);
      const task = makeTask({
        id: 'T076',
        action: 'create',
        suggestedFiles: ['src/a.ts', 'src/b.ts', 'src/locked/c.ts'],
      });
      const state = makeImplState([task], {
        workspace: { kind: 'checkout', path: projectDir, base: { snapshotId: 'base', head: null } },
      });
      saveState(ref, state);
      const { bus } = makeBusRecorder();
      let calls = 0;
      const invoke = vi.fn(async () => {
        calls += 1;
        if (calls === 1)
          enqueueUserMessage({
            ...ref,
            state,
            bus,
            phase: 'implementing',
            message: plainUserMessage('also create B and C'),
          });
        return makeRunnerCallResult({
          status: 'completed',
          text: JSON.stringify({
            version: 1,
            files:
              calls === 1
                ? [{ path: 'src/a.ts', action: 'create', content: 'A\n' }]
                : [
                    { path: 'src/b.ts', action: 'create', content: 'B\n' },
                    { path: 'src/locked/c.ts', action: 'create', content: 'C\n' },
                  ],
          }),
        });
      });
      const implementer = createImplementerBase(
        makeBaseConfig({ outputContract: 'file-bundle-v1', invoke }),
      );
      const wctx = makeWctx({ ...ref, implementer, bus });
      const snapshot = await getChangedFilesSnapshot(projectDir);
      try {
        const initialWorkspace =
          caller === 'retry-invoker'
            ? await wctx.isolation.acquire({ role: 'implementer', config: wctx.config })
            : undefined;
        const invoker = makeImplementerRetryInvoker({
          context: wctx.context,
          kind: 'local',
          sessionId: ref.sessionId,
          languageContext: buildLanguageContext('typescript'),
          phase: 'implementing',
        });
        const run =
          caller === 'implementation'
            ? await runImplementation({
                wctx,
                task,
                state,
                taskStartSnapshot: snapshot,
                setTrackedState: vi.fn(),
                recordApprovalDenial: vi.fn(),
              })
            : undefined;
        const result =
          run?.implResult ??
          (await invoker({
            task,
            lastError: 'validation failed',
            attempts: state.attempt,
            projectDir,
            implementer,
            config: wctx.config,
            createdByThisTask: [],
            seat: { ref: { ...ref, bus }, state, usageCategory: 'implementer' },
          }));
        const workspace = run?.workspace ?? initialWorkspace;
        if (workspace === undefined) throw new Error('Missing attempt workspace');
        expect(result.applyResult).toMatchObject({
          status: 'partial',
          failedPath: 'src/locked/c.ts',
          applied: [{ path: 'src/b.ts', action: 'create' }],
        });
        expect(recordedApiCreatedPaths(ref, task, projectDir)).toEqual(['src/a.ts', 'src/b.ts']);
        const receipt = result.applyResult;
        if (receipt?.status !== 'partial') throw new Error('Expected partial application');
        await raiseApiApplyRecovery({
          wctx,
          state: loadState(ref) ?? state,
          task,
          result: receipt,
          workspace,
        });

        expect(existsSync(join(projectDir, 'src/a.ts'))).toBe(false);
        expect(existsSync(join(projectDir, 'src/b.ts'))).toBe(false);
        expect(recordedApiCreatedPaths(ref, task, projectDir)).toEqual([]);
        expect(readEvidenceLedger(ref)?.tasks[0]?.apiApply?.revertedPaths).toEqual([
          'src/a.ts',
          'src/b.ts',
        ]);

        writeFileSync(join(projectDir, 'src/a.ts'), 'operator replacement\n');
        const coldInvoke = vi.fn(async () =>
          makeRunnerCallResult({ status: 'completed', text: '' }),
        );
        const coldImplementer = createImplementerBase(
          makeBaseConfig({ outputContract: 'file-bundle-v1', invoke: coldInvoke }),
        );
        const cold = await invoker({
          task,
          lastError: 'partial application',
          attempts: state.attempt,
          projectDir,
          implementer: coldImplementer,
          config: wctx.config,
          createdByThisTask: [],
          seat: {
            ref: { ...ref, bus },
            state: loadState(ref) ?? state,
            usageCategory: 'implementer',
          },
        });
        expect(cold.applyResult).toMatchObject({ status: 'rejected', code: 'baseline-conflict' });
        expect(coldInvoke).not.toHaveBeenCalled();
        expect(readFileSync(join(projectDir, 'src/a.ts'), 'utf8')).toBe('operator replacement\n');
      } finally {
        chmodSync(locked, 0o755);
        await wctx.isolation.dispose();
      }
    });

    it.each(['modify', 'transport-failure', 'modify-then-failure'] as const)(
      'keeps creation evidence through %s and a cold continuation',
      async (ending) => {
        const { projectDir } = setupProject(`bundle-correction-${caller}-${ending}`);
        const ref = { projectDir, sessionId: `bundle-${caller}-${ending}` };
        ensureSessionDir(projectDir, ref.sessionId);
        const task = makeTask({ id: 'T075', suggestedFiles: ['src/owned.ts'], action: 'create' });
        const state = makeImplState([task], {
          workspace: {
            kind: 'checkout',
            path: projectDir,
            base: { snapshotId: 'base', head: null },
          },
        });
        saveState(ref, state);
        const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
        const { bus } = makeBusRecorder();
        const requests: InvokeOpts[] = [];
        const invoke = vi.fn(async (request: InvokeOpts) => {
          requests.push(request);
          const count = requests.length;
          if (count > 1) {
            expect(recordedApiCreatedPaths(ref, task, projectDir)).toEqual(['src/owned.ts']);
            expect(request.prompt).toContain('keep the ownership proof');
          }
          if (count === 1 || (ending === 'modify-then-failure' && count === 2)) {
            enqueueUserMessage({
              ...ref,
              state,
              bus,
              phase: 'implementing',
              message: plainUserMessage(
                count === 1 ? 'keep the ownership proof' : 'check it once more',
              ),
            });
          }
          if (
            (ending === 'transport-failure' && count === 2) ||
            (ending === 'modify-then-failure' && count === 3)
          ) {
            return makeRunnerCallResult({
              status: 'failed',
              text: '',
              error: { code: 'transport-error', message: 'connection lost' },
              usage: { inputTokens: 10, outputTokens: 4 },
            });
          }
          return makeRunnerCallResult({
            status: 'completed',
            text: JSON.stringify({
              version: 1,
              files: [
                {
                  path: 'src/owned.ts',
                  action: count === 1 ? 'create' : 'modify',
                  content: `export const owned = ${count};\n`,
                },
              ],
            }),
            usage: { inputTokens: 10, outputTokens: 4 },
          });
        });
        const implementer = createImplementerBase(
          makeBaseConfig({ outputContract: 'file-bundle-v1', invoke }),
        );
        const wctx = makeWctx({ ...ref, implementer, bus });
        const call = async (activeImplementer: Implementer) => {
          const current = loadState(ref) ?? state;
          if (caller === 'retry-invoker') {
            const invoker = makeImplementerRetryInvoker({
              context: wctx.context,
              kind: 'local',
              sessionId: ref.sessionId,
              languageContext: buildLanguageContext('typescript'),
              phase: 'implementing',
            });
            return invoker({
              task,
              lastError: 'validation failed',
              attempts: current.attempt,
              projectDir,
              implementer: activeImplementer,
              config: wctx.config,
              fileIgnoreProjectDir: projectDir,
              createdByThisTask: recordedApiCreatedPaths(ref, task, projectDir),
              seat: { ref: { ...ref, bus }, state: current, usageCategory: 'implementer' },
            });
          }
          const result = await runImplementation({
            wctx: { ...wctx, implementer: activeImplementer },
            task,
            state: current,
            taskStartSnapshot,
            setTrackedState: vi.fn(),
            recordApprovalDenial: vi.fn(),
          });
          await result.workspace.retain?.();
          return result.implResult;
        };

        try {
          const result = await call(implementer);
          expect(invoke).toHaveBeenCalledTimes(ending === 'modify-then-failure' ? 3 : 2);
          expect(result.success).toBe(ending === 'modify');
          expect(result.usage).toEqual(
            ending === 'modify-then-failure'
              ? { inputTokens: 30, outputTokens: 12 }
              : { inputTokens: 20, outputTokens: 8 },
          );
          expect(recordedApiCreatedPaths(ref, task, projectDir)).toEqual(['src/owned.ts']);
          const receipt = readEvidenceLedger(ref)?.tasks.find(
            (entry) => entry.id === task.id,
          )?.apiApply;
          expect(receipt?.applied[0]).toMatchObject({
            path: 'src/owned.ts',
            action: ending === 'transport-failure' ? 'create' : 'modify',
          });
          expect(readFileSync(join(projectDir, 'src/owned.ts'), 'utf8')).toBe(
            `export const owned = ${ending === 'transport-failure' ? 1 : 2};\n`,
          );
          expect(
            loadState(ref)?.messageQueue.every(
              (message) => message.deliveredTo?.implementer !== undefined,
            ),
          ).toBe(true);

          const coldInvoke = vi.fn(async () =>
            makeRunnerCallResult({
              status: 'completed',
              text: JSON.stringify({
                version: 1,
                files: [
                  { path: 'src/owned.ts', action: 'modify', content: 'export const owned = 4;\n' },
                ],
              }),
            }),
          );
          const coldResult = await call(
            createImplementerBase(
              makeBaseConfig({ outputContract: 'file-bundle-v1', invoke: coldInvoke }),
            ),
          );
          expect(coldResult, JSON.stringify(coldResult)).toMatchObject({ success: true });
          expect(coldInvoke).toHaveBeenCalledTimes(1);
          expect(readFileSync(join(projectDir, 'src/owned.ts'), 'utf8')).toBe(
            'export const owned = 4;\n',
          );
        } finally {
          await wctx.isolation.dispose();
        }
      },
    );
  },
);

describe('runImplementation corrections against the persisted head', () => {
  it.each(['implement', 'retry'] as const)(
    'delivers an attachment received during the first %s call in a correction pass before returning',
    async (firstCall) => {
      const { projectDir } = setupProject('call-boundary-correction');
      const sessionId = 'call-boundary-correction-session';
      ensureSessionDir(projectDir, sessionId);
      const task = makeTask({ id: 'T074', suggestedFiles: ['src/corrected.ts'], action: 'create' });
      const state = makeImplState([task], { attempt: 2 });
      saveState({ projectDir, sessionId }, state);
      const message = attachedMessage(projectDir);
      const imagePath = join(projectDir, 'reference.png');
      writeFileSync(imagePath, 'image fixture');
      message.images = [
        {
          id: 'correction-shot',
          kind: 'image',
          path: imagePath,
          mimeType: 'image/png',
          sizeBytes: 13,
        },
      ];
      message.attachedInputs.push({ kind: 'image', path: imagePath });
      const snapshot = await getChangedFilesSnapshot(projectDir);
      const { bus, events } = makeBusRecorder();
      const calls: ImplementerOptions[] = [];
      const implementer = makeImplementer({
        implement: vi.fn(async (call: ImplementerOptions) => {
          calls.push(call);
          if (calls.length === 1) {
            mkdirSync(join(call.projectDir, 'src'), { recursive: true });
            writeFileSync(
              join(call.projectDir, 'src/corrected.ts'),
              'export const corrected = 1;\n',
            );
            enqueueUserMessage({
              projectDir,
              sessionId,
              state,
              bus,
              phase: 'implementing',
              message,
            });
            return { success: true, output: 'first', usage: { inputTokens: 10, outputTokens: 4 } };
          }
          return { success: true, output: 'corrected', usage: { inputTokens: 7, outputTokens: 5 } };
        }),
      });
      if (firstCall === 'retry') implementer.retry = vi.fn((call) => implementer.implement(call));
      const wctx = makeWctx({
        projectDir,
        sessionId,
        implementer,
        bus,
        config: makeNoValidationConfig({
          implementer: { kind: 'cli', tool: 'codex', model: 'fixture' },
        }),
      });

      const result = await runImplementation({
        wctx,
        task,
        state,
        taskStartSnapshot: snapshot,
        setTrackedState: vi.fn(),
        recordApprovalDenial: vi.fn(),
        ...(firstCall === 'retry' && { retryError: 'previous check failed' }),
      });

      expect(implementer.implement).toHaveBeenCalledTimes(2);
      if (firstCall === 'retry') expect(implementer.retry).toHaveBeenCalledTimes(1);
      const pass = calls[1];
      expect(pass?.task.id).toBe(task.id);
      expect(pass?.continuation?.steer).toContain(message.text);
      expect(pass?.continuation?.steer).toContain(`[image:correction-shot] = ${imagePath}`);
      expect(pass?.images).toEqual(message.images);
      expect(pass?.continuation?.partial).toBeUndefined();
      expect(pass?.continuation?.extra).toContain('src/corrected.ts');
      expect(pass?.allowNoChange).toBe(true);
      expect(pass?.onOutput).toBe(calls[0]?.onOutput);
      expect(pass?.approveWrite).toBe(calls[0]?.approveWrite);
      expect(result.implResult).toMatchObject({
        success: true,
        output: 'corrected',
        usage: { inputTokens: 17, outputTokens: 9 },
      });
      for (const finalState of [result.state, loadState({ projectDir, sessionId })]) {
        expect(finalState?.attempt).toBe(2);
        expect(finalState?.messageQueue[0]).toMatchObject(message);
        expect(finalState?.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
        expect(finalState?.lineages?.T074?.corrections).toEqual([
          expect.stringContaining(message.text),
        ]);
      }
      expect(events.filter((event) => event.type === 'queue_drained')).toEqual([
        expect.objectContaining({ seat: 'build', taskId: task.id, count: 1 }),
      ]);
      result.workspace.cleanup();
      await wctx.isolation.dispose();
    },
  );

  it.each(['seed', 'parked'] as const)(
    'keeps exact attachment text from a %s correction beside saved corrections',
    async (route) => {
      const { projectDir } = setupProject('seed-correction-head');
      const sessionId = 'seed-correction-head-session';
      ensureSessionDir(projectDir, sessionId);
      const task = makeTask({ id: 'T070', suggestedFiles: ['src/seeded.ts'], action: 'create' });
      const stale = makeImplState([task]);
      saveState({ projectDir, sessionId }, stale);
      transitionAndSave({ projectDir, sessionId }, stale, {
        type: 'RECORD_CORRECTION',
        taskId: task.id,
        text: 'first correction',
      });
      const implementer = makeImplementer();
      const message = attachedMessage(projectDir);
      message.images = [
        {
          id: 'seed-image',
          kind: 'image',
          path: '/seed.png',
          mimeType: 'image/png',
          sizeBytes: 12,
        },
      ];
      const { bus, events } = makeBusRecorder();
      let parked = route === 'parked';
      const wctx = makeWctx({
        projectDir,
        sessionId,
        implementer,
        bus,
        callbacks: makeCallbacks({ onContinuationNeeded: async () => message }).callbacks,
        ...(route === 'seed' && {
          continuation: createContinuationHolder({
            step: { kind: 'brief', taskId: task.id, attempt: stale.attempt },
            steer: message,
          }),
        }),
      });
      wctx.sinks = {
        ...wctx.sinks,
        consumeBoundaryInterrupt: () => {
          const result = parked;
          parked = false;
          return result;
        },
      };

      const result = await runImplementation({
        wctx,
        task,
        state: stale,
        taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
        setTrackedState: vi.fn(),
        recordApprovalDenial: vi.fn(),
      });

      for (const saved of [result.state, loadState({ projectDir, sessionId })]) {
        expect(saved?.lineages?.T070?.corrections).toEqual([
          'first correction',
          `${message.text}\n\nAttached image paths:\n[image:seed-image] = /seed.png`,
        ]);
      }
      const steer = vi.mocked(implementer.implement).mock.calls[0]?.[0].continuation?.steer;
      expect(steer).toContain('first correction');
      expect(steer).toBe(
        `first correction\n\n${message.text}\n\nAttached image paths:\n[image:seed-image] = /seed.png`,
      );
      expect(vi.mocked(implementer.implement).mock.calls[0]?.[0].images).toBeUndefined();
      expect(events.filter((event) => event.type === 'build_images_as_paths')).toEqual([
        expect.objectContaining({ taskId: task.id, count: 1 }),
      ]);
    },
  );

  it('carries queued text once per call and records it once', async () => {
    const { projectDir } = setupProject('queued-correction-once');
    const sessionId = 'queued-correction-once-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T071', suggestedFiles: ['src/queued.ts'], action: 'create' });
    const initial = makeImplState([task]);
    saveState({ projectDir, sessionId }, initial);
    const { bus } = makeBusRecorder();
    const state = enqueueUserMessage({
      projectDir,
      sessionId,
      state: initial,
      message: plainUserMessage('name the helper parseAmount'),
      phase: 'implementing',
      bus,
    }).state;
    const implementer = makeImplementer();

    await runImplementation({
      wctx: makeWctx({ projectDir, sessionId, implementer, bus }),
      task,
      state,
      taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
    });

    const steer = vi.mocked(implementer.implement).mock.calls[0]?.[0].continuation?.steer ?? '';
    expect(steer.split('name the helper parseAmount')).toHaveLength(2);
    const corrections = loadState({ projectDir, sessionId })?.lineages?.T071?.corrections ?? [];
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toContain('name the helper parseAmount');
  });

  it('leaves queued text pending and unrecorded when the run stops before the call', async () => {
    const { projectDir } = setupProject('queued-correction-stopped');
    const sessionId = 'queued-correction-stopped-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T073', suggestedFiles: ['src/stopped.ts'], action: 'create' });
    const initial = makeImplState([task]);
    saveState({ projectDir, sessionId }, initial);
    const { bus } = makeBusRecorder();
    const state = enqueueUserMessage({
      projectDir,
      sessionId,
      state: initial,
      message: plainUserMessage('wait for me'),
      phase: 'implementing',
      bus,
    }).state;
    const run = new AbortController();
    run.abort();
    const implementer = makeImplementer();

    await expect(
      runImplementation({
        wctx: makeWctx({ projectDir, sessionId, implementer, bus, signal: run.signal }),
        task,
        state,
        taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
        setTrackedState: vi.fn(),
        recordApprovalDenial: vi.fn(),
      }),
    ).rejects.toThrow();

    expect(implementer.implement).not.toHaveBeenCalled();
    const saved = loadState({ projectDir, sessionId });
    expect(saved?.lineages?.T073?.corrections).toBeUndefined();
    expect(saved?.messageQueue.map((message) => message.text)).toEqual(['wait for me']);
    expect(saved?.messageQueue[0]?.drainedAt).toBeUndefined();
  });

  it('records no correction for queued text the user cleared before it was delivered', async () => {
    const { projectDir } = setupProject('queued-correction-cleared');
    const sessionId = 'queued-correction-cleared-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T072', suggestedFiles: ['src/cleared.ts'], action: 'create' });
    const initial = makeImplState([task]);
    saveState({ projectDir, sessionId }, initial);
    const { bus } = makeBusRecorder();
    const state = enqueueUserMessage({
      projectDir,
      sessionId,
      state: initial,
      message: plainUserMessage('never mind'),
      phase: 'implementing',
      bus,
    }).state;
    const isolation = makeCopyingIsolation({ projectDir, sessionId });
    const acquire = isolation.acquire;
    let cleared = false;
    isolation.acquire = async (opts) => {
      const workspace = await acquire(opts);
      clearPendingQueue({ projectDir, sessionId, state, bus });
      cleared = true;
      return workspace;
    };

    const result = await runImplementation({
      wctx: makeWctx({ projectDir, sessionId, implementer: makeImplementer(), bus, isolation }),
      task,
      state,
      taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
    });

    expect(cleared).toBe(true);
    expect(loadState({ projectDir, sessionId })?.lineages?.T072?.corrections).toBeUndefined();
    result.workspace.cleanup();
    await isolation.dispose();
  });
});

describe('BUILD steering wiring', () => {
  it.each([undefined, 'checks failed'])(
    'passes one port to the initial call and correction with retryError=%s',
    async (retryError) => {
      const { projectDir } = setupProject('build-steering');
      const ref = { projectDir, sessionId: 'build-steering-session' };
      ensureSessionDir(projectDir, ref.sessionId);
      const task = makeTask();
      const state = makeImplState([task]);
      saveState(ref, state);
      const { bus, events } = makeBusRecorder();
      const steering = createSteeringPort();
      const delivery = Promise.withResolvers<SteerOutcome>();
      const acquired = Promise.withResolvers<void>();
      const detach = steering.attach({
        callId: 'prior-build',
        role: 'implementer',
        taskId: task.id,
        send: () => delivery.promise,
      });
      const handler = createQueueHandler({
        config: makeNoValidationConfig(),
        ...ref,
        steering,
        bus,
        planner: makePlanner(),
        serialize: createWriteSequencer(),
        getState: () => state,
        setState: () => {},
      });
      await handler(plainUserMessage('keep this correction on retries'), state.phase);
      detach();
      const calls: ImplementerOptions[] = [];
      const run = async (call: ImplementerOptions) => {
        calls.push(call);
        if (calls.length === 1)
          enqueueUserMessage({
            ...ref,
            state,
            bus,
            message: plainUserMessage('keep the API'),
            phase: state.phase,
          });
        return { success: true, output: '' };
      };
      const implement = vi.fn(run);
      const retry = vi.fn((call: RetryOptions) => run(call));
      const workspace: AttemptWorkspace = {
        projectDir: ref.projectDir,
        sandboxEnv: {},
        snapshot: { head: GIT_EMPTY_TREE_HASH, files: [], dirtyFileContents: {} },
        targetBaseline: undefined,
        cleanup: () => {},
        changedFiles: async () => [],
        revert: async () => {},
      };
      const isolation: RunIsolation = {
        open: async () => ({
          kind: 'checkout',
          projectDir: ref.projectDir,
          head: null,
          keptFiles: [],
        }),
        acquire: async () => {
          acquired.resolve();
          return workspace;
        },
        dispose: async () => {},
      };
      const running = runImplementation({
        wctx: makeWctx({
          ...ref,
          bus,
          steering,
          isolation,
          implementer: makeImplementer({ implement, retry }),
        }),
        task,
        state,
        taskStartSnapshot: workspace.snapshot,
        setTrackedState: () => {},
        recordApprovalDenial: () => {},
        retryError,
      });
      await acquired.promise;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const callsBeforeDelivery = calls.length;
      delivery.resolve('delivered');
      const result = await running;
      expect(callsBeforeDelivery).toBe(0);
      expect(result.implResult.success).toBe(true);
      expect(calls).toHaveLength(2);
      for (const call of calls) expect(call.steering).toBe(steering);
      expect(calls[0]?.continuation?.steer).toContain('keep this correction on retries');
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'queue_drained', via: 'mid-call' }),
      );
      expect(calls[1]?.continuation?.steer).toContain('keep the API');
      expect(retry).toHaveBeenCalledTimes(retryError === undefined ? 0 : 1);
      expect(steering.current()).toBeNull();
    },
  );
});
