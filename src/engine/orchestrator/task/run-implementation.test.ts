import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import { normalizeCustomCommand } from '../../../core/config/custom-commands.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import {
  makeBusRecorder,
  makeCallbacks,
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
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createStagedProject } from '../approval/staged-project.js';
import { applyChangedFiles } from './apply-changed-files.js';
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
    file: '.env.local',
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
      enabled: true,
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

  const applied = await applyChangedFiles({
    wctx,
    task,
    state: implementation.state,
    workspace,
    preApplyApprovedFiles: implementation.preApplyApprovedFiles,
    taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
    recordApprovalDenial: vi.fn(),
    handleConflict: async (currentState) => currentState,
  });

  expect(applied.proceed).toBe(approval === 'approved');
  expect(existsSync(workspace.projectDir)).toBe(false);
  expect(existsSync(join(projectDir, '.env.local'))).toBe(approval === 'approved');
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
    expect(result.workspace).toBeUndefined();
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

describe('runImplementation worktree freshness', () => {
  async function capturedFresh(
    seed: { partial?: string; steer?: string; attempt?: number; keepWorkspace?: true } | undefined,
    stateOverrides?: Partial<WorkflowState>,
  ): Promise<boolean | undefined> {
    const { projectDir } = setupProject('reseed');
    const task = makeTask({ id: 'T040', file: 'src/reseed.ts', action: 'create' });
    const state = makeImplState([task], stateOverrides);
    const freshArgs: Array<boolean | undefined> = [];
    const isolation: RunIsolation = {
      acquire: async (opts) => {
        freshArgs.push(opts.fresh);
        return {
          projectDir,
          sandboxEnv: {},
          snapshot: await getChangedFilesSnapshot(projectDir),
          targetBaseline: undefined,
          changeDetection: 'file-hashes',
          cleanup: () => {},
        };
      },
      dispose: async () => {},
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

    expect(freshArgs).toHaveLength(1);
    return freshArgs[0];
  }

  it('reseeds a first attempt that carries no continuation seed', async () => {
    expect(await capturedFresh(undefined)).toBe(true);
  });

  it('reseeds when a correction alone continues the brief', async () => {
    // A retry-exhausted brief restored its files in the project tree; a typed
    // correction is guidance, not a mid-step resume, so the worktree must reseed.
    expect(await capturedFresh({ steer: 'use the smaller helper' })).toBe(true);
  });

  it('keeps the worktree for a genuine mid-step park continuation', async () => {
    // A genuine park carries what `resumeContinuation` records: the partial and the keep flag.
    expect(await capturedFresh({ partial: 'half a brief', keepWorkspace: true })).toBe(false);
  });

  it("reseeds when a prior attempt's partial no longer matches the reset attempt", async () => {
    // The park left a partial at attempt 2; the ladder reset the brief to attempt
    // 0, so the stale partial does not resume it and the worktree reseeds clean.
    expect(await capturedFresh({ partial: 'half a brief', attempt: 2 })).toBe(true);
  });
});

describe('runImplementation seat trouble', () => {
  it('retries a transient failure without counting an attempt and keeps the discarded usage', async () => {
    const { projectDir } = setupProject('seat-retry');
    const sessionId = 'seat-retry-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T060', file: 'src/retry.ts', action: 'create' });
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

describe('runImplementation continuation note', () => {
  it('names the declared files that already differ from the commit the brief started on', async () => {
    const { projectDir } = setupProject('reseed-note');
    const task = makeTask({ id: 'T041', file: 'src/reseed.ts', action: 'create' });
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    // Written after the task-start snapshot and before the call, as a reset brief finds it.
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/reseed.ts'), 'export const reseed = 1;\n');
    const implementer = makeImplementer({ capabilities: { writesFiles: 'direct' } });
    const isolation: RunIsolation = {
      acquire: async () => ({
        projectDir,
        sandboxEnv: {},
        snapshot: await getChangedFilesSnapshot(projectDir),
        targetBaseline: undefined,
        changeDetection: 'file-hashes',
        cleanup: () => {},
      }),
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
        'These declared files already differ from the commit this brief started on: src/reseed.ts',
    });
  });
});

describe('runImplementation plan context', () => {
  it("puts the run's plan decisions and the task's criteria in the brief it dispatches", async () => {
    const { projectDir } = setupProject('plan-context');
    const sessionId = 'plan-context-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T070', file: 'src/plan.ts', action: 'create', criteria: ['C1'] });
    const prompts: string[] = [];
    const invoke = vi.fn().mockImplementation(async (call: { prompt: string }) => {
      prompts.push(call.prompt);
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));
    const state = makeImplState([task], {
      plan: {
        summary: 'Greet people by name',
        decisions: ['PLAN-DECISION: keep the greeting in one module'],
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
    const task = makeTask({ id: 'T050', file: 'src/preview.ts', action: 'modify' });
    const { bus, events } = makeBusRecorder();
    const isolation: RunIsolation = {
      acquire: async () => ({
        projectDir,
        sandboxEnv: {},
        snapshot: await getChangedFilesSnapshot(projectDir),
        targetBaseline: undefined,
        changeDetection: 'file-hashes',
        cleanup: () => {},
      }),
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
