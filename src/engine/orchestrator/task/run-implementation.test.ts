import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
import { transitionAndSave } from '../state-ops.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { clearPendingQueue } from '../queue/clear.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeCopyingIsolation,
  makeImplementer,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { createContinuationHolder } from '../continuation.js';
import type { RunIsolation } from '../isolation/types.js';
import type { Implementer, ImplementerOptions } from '../../implementers/types.js';
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
      implementer: makeImplementer({
        capabilities: { writesFiles: 'extracted-code' },
        implement: async (opts: ImplementerOptions) => {
          receivedDirs.push(opts.projectDir);
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
    seed: { partial?: string; steer?: string; attempt?: number; keepWorkspace?: true } | undefined,
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
    expect(await capturedResume({ steer: 'use the smaller helper' })).toBe(false);
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
      callbacks: makeCallbacks({ onContinuationNeeded: async () => correction }).callbacks,
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
      steer: 'use the registry',
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
      steer: 'use the registry',
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

describe('runImplementation corrections against the persisted head', () => {
  it('keeps a correction already saved when the seed brings another', async () => {
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

    const result = await runImplementation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        implementer,
        continuation: createContinuationHolder({
          step: { kind: 'brief', taskId: task.id, attempt: stale.attempt },
          steer: 'second correction',
        }),
      }),
      task,
      state: stale,
      taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
    });

    for (const saved of [result.state, loadState({ projectDir, sessionId })]) {
      expect(saved?.lineages?.T070?.corrections).toEqual(['first correction', 'second correction']);
    }
    const steer = vi.mocked(implementer.implement).mock.calls[0]?.[0].continuation?.steer;
    expect(steer).toContain('first correction');
    expect(steer).toContain('second correction');
  });

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
      text: 'name the helper parseAmount',
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
      text: 'wait for me',
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
      text: 'never mind',
      phase: 'implementing',
      bus,
    }).state;
    let cleared = false;
    const setTrackedState = vi.fn((tracked: WorkflowState) => {
      if (cleared) return;
      cleared = true;
      clearPendingQueue({ projectDir, sessionId, state: tracked, bus });
    });

    await runImplementation({
      wctx: makeWctx({ projectDir, sessionId, implementer: makeImplementer(), bus }),
      task,
      state,
      taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
      setTrackedState,
      recordApprovalDenial: vi.fn(),
    });

    expect(cleared).toBe(true);
    expect(loadState({ projectDir, sessionId })?.lineages?.T072?.corrections).toBeUndefined();
  });
});
