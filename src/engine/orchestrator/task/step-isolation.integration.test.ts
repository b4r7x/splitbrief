import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
  makePlanner,
  openRunWorkspace,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import {
  cannotConsult,
  consultCallAnswering,
  guidanceConsult,
} from '#testing/helpers/typed-planner.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { TypedCallContext } from '../../planners/types.js';
import type { TypedSeatCall } from '../../runners/typed-output.js';
import { isolationWorktreeRoot, SPLITBRIEF_DIR } from '../../../core/paths.js';
import { createRunIsolation } from '../isolation/create.js';
import { readWorkspaceRecord } from '../isolation/retention.js';
import { createImplementerBase } from '../../implementers/pipeline/run.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import type { BundleApplyResult } from '../../implementers/file-bundle/contract.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { applyRecoveryAction } from '../recovery/actions/apply.js';
import { runSingleTask } from './step.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTaskProjects();
});

/** Every checkout file outside git and SPLITBRIEF's own state, with its bytes. */
function checkoutFiles(projectDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(projectDir, path);
      if (rel === '.git' || rel === SPLITBRIEF_DIR) continue;
      if (entry.isDirectory()) walk(path);
      else files[rel] = readFileSync(path).toString('base64');
    }
  };
  walk(projectDir);
  return files;
}

describe('runSingleTask — worktree isolation', () => {
  it('keeps the checkout byte-identical across a failing task and a passing task', {
    timeout: 90_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const failing = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['src/main.ts'] },
      checks: [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit' }],
    });
    const passing = makeTask({
      id: 'T002',
      action: 'create',
      suggestedFiles: ['src/b.ts'],
      scope: { inBounds: ['src/b.ts'] },
    });
    const state = implementingState([failing, passing]);
    const before = checkoutFiles(projectDir);

    const receivedDirs: string[] = [];
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        receivedDirs.push(opts.projectDir);
        const target = join(opts.projectDir, opts.task.suggestedFiles[0]);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(
          target,
          `export const ${basename(opts.task.suggestedFiles[0], '.ts')} = 999;\n`,
        );
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: 'still broken',
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    });
    // Only T001 carries a check, and it stays red.
    vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
      processError.exitCode({ command: 'tsc', code: 2, stderr: 'T001 is broken', output: '' }),
    );
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
    });
    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks: makeCallbacks().callbacks,
        implementer,
        bus: makeBusRecorder().bus,
        isolation,
        config: makeConfig({ workflow: { review: 'task' } }),
        planner: makePlanner({
          typedCall: consultCallAnswering(() => {
            throw new Error('The planner process stopped unexpectedly.');
          }),
        }),
      }),
    );

    const afterFailing = await runSingleTask({
      wctx,
      task: failing,
      index: 0,
      totalTasks: 2,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    expect(afterFailing.pendingRecovery?.reason).toBe('planner-call-failed');
    expect(checkoutFiles(projectDir)).toEqual(before);

    const afterPassing = await runSingleTask({
      wctx,
      task: passing,
      index: 1,
      totalTasks: 2,
      // The halt leaves the brief escalating; moving on starts the next brief from implementing.
      state: {
        ...afterFailing,
        phase: 'implementing',
        pendingRecovery: undefined,
        currentTaskIndex: 1,
      },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    expect(afterPassing.tasks[1]?.status).toBe('done');
    expect(checkoutFiles(projectDir)).toEqual(before);

    expect(receivedDirs).toEqual([wctx.workspaceDir, wctx.workspaceDir]);
    expect(wctx.workspaceDir).not.toBe(projectDir);
    // The failing brief's *Seat down* halt kept its file in the run workspace.
    expect(readFileSync(join(wctx.workspaceDir, 'src/main.ts'), 'utf-8')).toBe(
      'export const main = 999;\n',
    );
    expect(readFileSync(join(wctx.workspaceDir, 'src/b.ts'), 'utf-8')).toBe(
      'export const b = 999;\n',
    );
    expect(readdirSync(isolationWorktreeRoot(realpathSync(join(projectDir, '.git'))))).toHaveLength(
      1,
    );

    await isolation.dispose();
  });

  it("keeps a stopped attempt's partial in the run workspace when its call throws on the stop", {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/partial.ts'],
      scope: { inBounds: ['src/partial.ts'] },
    });
    const controller = new AbortController();
    const invoke = vi.fn().mockImplementation(async (opts: { projectDir: string }) => {
      mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
      writeFileSync(join(opts.projectDir, 'src/partial.ts'), 'export const partial = 1;\n');
      controller.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
    });
    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks: makeCallbacks().callbacks,
        implementer: createImplementerBase(makeBaseConfig({ extractsCode: false, invoke })),
        bus: makeBusRecorder().bus,
        isolation,
        signal: controller.signal,
      }),
    );
    const before = checkoutFiles(projectDir);

    await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state: implementingState([task]),
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    await isolation.dispose();

    expect(readFileSync(join(wctx.workspaceDir, 'src/partial.ts'), 'utf-8')).toBe(
      'export const partial = 1;\n',
    );
    expect((await readWorkspaceRecord({ projectDir, sessionId }))?.retained).toBe(true);
    expect(checkoutFiles(projectDir)).toEqual(before);
  });
});

describe('runSingleTask — what a revert or a restore leaves of the brief', () => {
  const task = makeTask({
    id: 'T001',
    action: 'modify',
    suggestedFiles: ['src/main.ts', 'src/extra.ts'],
    scope: { inBounds: ['src/main.ts', 'src/extra.ts'] },
    checks: [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit' }],
  });

  /**
   * A BUILD call's result; a failed call names the outcome its runner reported, when it reported
   * one, and the edit bundle it applied, when it applied one.
   */
  type CallResult = {
    success: boolean;
    outcome?: 'implementer-left-isolation' | 'checkout-changed';
    applyResult?: BundleApplyResult;
  };

  /**
   * Runs the brief until a consult fails, and records the prompt of every consult. The task start
   * is saved as the task loop saves it, so each consult reads the task diff. A consult past the
   * scripted answers throws, or fails with `consultStop` as the planner tool's own failed call.
   */
  async function runUntilHalt(opts: {
    implement: (dir: string) => CallResult;
    retry?: (dir: string) => CallResult;
    answers: Array<() => ConsultAnswer>;
    consultStop?: { code: string; message: string };
  }) {
    const { projectDir, sessionId } = setupProject({
      'src/main.ts': 'export const main = 0;\n',
      'src/extra.ts': 'export const extra = 0;\n',
    });
    const usage = { inputTokens: 10, outputTokens: 5 };
    const result = (call: CallResult) =>
      call.success
        ? { success: true, output: 'ok', usage }
        : {
            success: false,
            error: 'seat error',
            usage,
            ...(call.outcome !== undefined && { outcome: call.outcome }),
            ...(call.applyResult !== undefined && { applyResult: call.applyResult }),
          };
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi
        .fn()
        .mockImplementation(async (call: ImplementerOptions) =>
          result(opts.implement(call.projectDir)),
        ),
      retry: vi
        .fn()
        .mockImplementation(async (call: ImplementerOptions) =>
          result((opts.retry ?? opts.implement)(call.projectDir)),
        ),
    });
    vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
      processError.exitCode({ command: 'tsc', code: 2, stderr: 'T001 is broken', output: '' }),
    );
    const rows: unknown[] = [];
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
      infoPublisher: (row) => {
        rows.push(row);
      },
    });
    const prompts: string[] = [];
    const answering = consultCallAnswering((prompt) => {
      const answer = opts.answers[prompts.length];
      prompts.push(prompt);
      if (answer === undefined) throw new Error('The planner process stopped unexpectedly.');
      return answer();
    });
    const typedCall = (ctx: TypedCallContext): TypedSeatCall => {
      const call = answering(ctx);
      const stop = opts.consultStop;
      if (stop === undefined) return call;
      return {
        ...call,
        invoke: async (input) => {
          if (!input.prompt.includes('# Consult') || opts.answers[prompts.length] !== undefined) {
            return call.invoke(input);
          }
          prompts.push(input.prompt);
          return makeRunnerCallResult({ status: 'failed', text: '', error: stop });
        },
      };
    };
    const recorder = makeBusRecorder();
    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks: makeCallbacks().callbacks,
        implementer,
        bus: recorder.bus,
        isolation,
        config: makeConfig({ workflow: { review: 'task' } }),
        planner: makePlanner({ typedCall }),
      }),
    );
    const state = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state: implementingState([task]),
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
      onTaskStartSnapshot: (startState, activeTaskSnapshot) => ({
        ...startState,
        changedFilesBaseline: { head: null, fingerprints: {}, activeTaskSnapshot },
      }),
    });
    await isolation.dispose();
    const warnings = recorder.events.filter((event) => event.type === 'warning');
    const errors = recorder.events.filter((event) => event.type === 'error');
    return {
      state,
      rows,
      warnings,
      errors,
      prompts,
      workspaceDir: wctx.workspaceDir,
      projectDir,
      sessionId,
      recorder,
    };
  }

  const write = (dir: string, file: string, text: string): void =>
    writeFileSync(join(dir, file), text);
  const read = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf-8');
  const noTaskChange = 'This task has changed no file since it started.';
  // The failed result frame of an agy consult that ran out of quota, without its reset: a reset
  // the run can read, with no fallback seat, is waited out instead of halting.
  const agyQuotaStop = {
    code: 'antigravity-result-failed',
    message: 'Individual quota reached. Please upgrade your subscription to increase your limits.',
  };
  const restoreRow = expect.objectContaining({ message: expect.stringMatching(/^Restored /) });

  it('keeps the files of a failed first call for the consult and the next attempt', {
    timeout: 120_000,
  }, async () => {
    const seen: string[] = [];
    const { state, rows, prompts } = await runUntilHalt({
      implement: (dir) => {
        write(dir, 'src/main.ts', 'export const main = 1;\n');
        return { success: false };
      },
      retry: (dir) => {
        seen.push(read(dir, 'src/main.ts'));
        return { success: false };
      },
      answers: [() => guidanceConsult('Fix the type error.')],
    });

    expect(seen).toEqual(['export const main = 1;\n']);
    expect(rows).toEqual([]);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain('+export const main = 1;');
      expect(prompt).not.toContain(noTaskChange);
    }
    expect(state.pendingRecovery?.reason).toBe('planner-call-failed');
  });

  it('keeps the files of a failed retry for the consult and the next attempt, and keeps every attempt at the halt', {
    timeout: 120_000,
  }, async () => {
    const seen: string[] = [];
    let retries = 0;
    const { state, rows, warnings, prompts, workspaceDir } = await runUntilHalt({
      implement: (dir) => {
        write(dir, 'src/main.ts', 'export const main = 1;\n');
        return { success: true };
      },
      retry: (dir) => {
        retries += 1;
        if (retries === 1) write(dir, 'src/extra.ts', 'export const extra = 1;\n');
        else seen.push(read(dir, 'src/extra.ts'));
        return { success: false };
      },
      answers: [
        () => guidanceConsult('Fix the type error.'),
        () => guidanceConsult('Fix the type error.'),
      ],
    });

    expect(seen).toEqual(['export const extra = 1;\n']);
    expect(rows).toEqual([]);
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts.slice(1)) {
      expect(prompt).toContain('+export const extra = 1;');
      expect(prompt).not.toContain(noTaskChange);
    }
    expect(state.pendingRecovery?.reason).toBe('planner-call-failed');
    expect(warnings).not.toContainEqual(restoreRow);
    expect(read(workspaceDir, 'src/main.ts')).toBe('export const main = 1;\n');
    expect(read(workspaceDir, 'src/extra.ts')).toBe('export const extra = 1;\n');
  });

  it('counts no file once the halt restore took back a file outside the declared files', {
    timeout: 120_000,
  }, async () => {
    let retries = 0;
    const { state, warnings, workspaceDir } = await runUntilHalt({
      implement: (dir) => {
        write(dir, 'src/helper.ts', 'export const helper = 1;\n');
        return { success: true };
      },
      retry: (dir) => {
        retries += 1;
        if (retries === 1) write(dir, 'src/extra.ts', 'export const extra = 1;\n');
        return { success: false };
      },
      answers: [() => guidanceConsult('Fix the type error.'), () => cannotConsult()],
    });

    expect(state.pendingRecovery?.reason).toBe('retry-exhausted');
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message:
          'Restored 2 changes of the failing brief to its start: src/extra.ts, src/helper.ts',
        briefKept: 0,
      }),
    );
    expect(existsSync(join(workspaceDir, 'src/helper.ts'))).toBe(false);
    expect(read(workspaceDir, 'src/extra.ts')).toBe('export const extra = 0;\n');
  });

  it('keeps the files of a call whose runner reported a defect, as that halt asks no consult', {
    timeout: 120_000,
  }, async () => {
    const { state, prompts, workspaceDir } = await runUntilHalt({
      implement: (dir) => {
        write(dir, 'src/main.ts', 'export const main = 1;\n');
        return { success: false, outcome: 'implementer-left-isolation' };
      },
      answers: [],
    });

    expect(state.pendingRecovery?.reason).toBe('implementer-left-isolation');
    expect(prompts).toEqual([]);
    expect(read(workspaceDir, 'src/main.ts')).toBe('export const main = 1;\n');
  });

  it('puts back the files of a call that changed the repository, as that halt needs you', {
    timeout: 120_000,
  }, async () => {
    const { state, prompts, workspaceDir } = await runUntilHalt({
      implement: (dir) => {
        write(dir, 'src/main.ts', 'export const main = 1;\n');
        return { success: false, outcome: 'checkout-changed' };
      },
      answers: [],
    });

    expect(state.pendingRecovery?.reason).toBe('checkout-changed');
    expect(prompts).toEqual([]);
    expect(read(workspaceDir, 'src/main.ts')).toBe('export const main = 0;\n');
  });

  it('keeps the files of a failed first call when the consult call fails and the ladder halts', {
    timeout: 120_000,
  }, async () => {
    const { state, warnings, workspaceDir } = await runUntilHalt({
      implement: (dir) => {
        write(dir, 'src/main.ts', 'export const main = 1;\n');
        return { success: false };
      },
      answers: [],
    });

    expect(warnings).not.toContainEqual(restoreRow);
    expect(state.pendingRecovery?.reason).toBe('planner-call-failed');
    expect(read(workspaceDir, 'src/main.ts')).toBe('export const main = 1;\n');
  });

  it('keeps the files of a first attempt whose check failed when the consult stops on a usage limit', {
    timeout: 120_000,
  }, async () => {
    const { state, warnings, prompts, workspaceDir } = await runUntilHalt({
      implement: (dir) => {
        write(dir, 'src/main.ts', 'export const main = 1;\n');
        return { success: true };
      },
      answers: [],
      consultStop: agyQuotaStop,
    });

    expect(state.pendingRecovery).toMatchObject({
      reason: 'runner-usage-limit',
      seat: 'plan',
      taskId: 'T001',
    });
    expect(prompts).toHaveLength(1);
    expect(warnings).not.toContainEqual(restoreRow);
    expect(read(workspaceDir, 'src/main.ts')).toBe('export const main = 1;\n');
    expect(read(workspaceDir, 'src/extra.ts')).toBe('export const extra = 0;\n');
  });

  it('still restores the files when the consult answers cannot and the brief halts as retry-exhausted', {
    timeout: 120_000,
  }, async () => {
    const { state, warnings, prompts, workspaceDir } = await runUntilHalt({
      implement: (dir) => {
        write(dir, 'src/main.ts', 'export const main = 1;\n');
        return { success: true };
      },
      answers: [() => cannotConsult()],
    });

    expect(state.pendingRecovery?.reason).toBe('retry-exhausted');
    expect(prompts).toHaveLength(1);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: 'Restored 1 change of the failing brief to its start: src/main.ts',
        briefKept: 0,
      }),
    );
    expect(read(workspaceDir, 'src/main.ts')).toBe('export const main = 0;\n');
  });

  it("puts the brief's files back on Skip after the consult stopped on a usage limit", {
    timeout: 120_000,
  }, async () => {
    const { state, workspaceDir, projectDir, sessionId, recorder } = await runUntilHalt({
      implement: (dir) => {
        write(dir, 'src/main.ts', 'export const main = 1;\n');
        return { success: true };
      },
      answers: [],
      consultStop: agyQuotaStop,
    });
    expect(state.pendingRecovery?.reason).toBe('runner-usage-limit');

    const skipped = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: {
        ...state,
        workspace: {
          kind: 'worktree',
          path: workspaceDir,
          base: { snapshotId: 'workspace-base', head: null },
        },
      },
      action: 'skip-current-task',
      bus: recorder.bus,
    });

    expect(skipped.ok).toBe(true);
    expect(skipped.state.tasks[0]?.status).toBe('skipped');
    expect(read(workspaceDir, 'src/main.ts')).toBe('export const main = 0;\n');
    expect(
      recorder.events.flatMap((event) =>
        event.type === 'warning' && event.message.startsWith('Restored ') ? [event.message] : [],
      ),
    ).toEqual(['Restored 1 change of the failing brief to its start: src/main.ts']);
  });

  it('keeps the files of a first call that threw for the consult and the next attempt', {
    timeout: 120_000,
  }, async () => {
    const seen: string[] = [];
    const { prompts } = await runUntilHalt({
      implement: (dir) => {
        write(dir, 'src/main.ts', 'export const main = 1;\n');
        throw new Error('The tool crashed.');
      },
      retry: (dir) => {
        seen.push(read(dir, 'src/main.ts'));
        return { success: false };
      },
      answers: [() => guidanceConsult('Fix the type error.')],
    });

    expect(seen).toEqual(['export const main = 1;\n']);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain('+export const main = 1;');
      expect(prompt).not.toContain(noTaskChange);
    }
  });

  it('keeps the files of a retry that threw until the halt restores the brief', {
    timeout: 120_000,
  }, async () => {
    const { rows, warnings, workspaceDir } = await runUntilHalt({
      implement: (dir) => {
        write(dir, 'src/main.ts', 'export const main = 1;\n');
        return { success: true };
      },
      retry: (dir) => {
        write(dir, 'src/extra.ts', 'export const extra = 1;\n');
        throw new Error('The tool crashed.');
      },
      answers: [() => guidanceConsult('Fix the type error.')],
    });

    expect(rows).toEqual([]);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: 'Restored 2 changes of the failing brief to its start: src/extra.ts, src/main.ts',
        briefKept: 0,
      }),
    );
    expect(read(workspaceDir, 'src/main.ts')).toBe('export const main = 0;\n');
    expect(read(workspaceDir, 'src/extra.ts')).toBe('export const extra = 0;\n');
  });

  it.each([
    ['a failed first call', false],
    ['a failed check', true],
  ])(
    'keeps the files of a retry whose edit bundle stopped part way, after %s',
    {
      timeout: 120_000,
    },
    async (_route, firstCallSucceeds) => {
      const landed = 'export const extra = 1;\n';
      // The bundle wrote src/extra.ts and stopped at src/main.ts.
      const stopped: BundleApplyResult = {
        callId: 'implementer-9',
        candidatePaths: ['src/extra.ts', 'src/main.ts'],
        status: 'partial',
        code: 'io-failure',
        error: 'src/main.ts: EACCES: permission denied',
        failedPath: 'src/main.ts',
        applied: [
          {
            path: 'src/extra.ts',
            action: 'modify',
            beforeSha256: sha256Hex(Buffer.from('export const extra = 0;\n', 'utf8')),
            afterSha256: sha256Hex(Buffer.from(landed, 'utf8')),
            diff: `+${landed}`,
            linesAdded: 1,
            linesRemoved: 1,
          },
        ],
        noops: [],
        untouched: ['src/main.ts'],
      };
      let retries = 0;
      const { state, errors, warnings, workspaceDir } = await runUntilHalt({
        implement: (dir) => {
          write(dir, 'src/main.ts', 'export const main = 1;\n');
          return { success: firstCallSucceeds };
        },
        retry: (dir) => {
          retries += 1;
          write(dir, 'src/extra.ts', landed);
          return { success: false, applyResult: stopped };
        },
        answers: [() => guidanceConsult('Fix the type error.')],
      });

      expect(retries).toBe(1);
      expect(state.pendingRecovery?.facts).toMatchObject({ apiApplyIncomplete: true });
      expect(errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('partial changes kept in the run workspace'),
        }),
      );
      expect(state.pendingRecovery?.details?.join('\n')).toContain(
        'The partial writes stay in the run workspace',
      );
      expect(read(workspaceDir, 'src/extra.ts')).toBe(landed);
      expect(read(workspaceDir, 'src/main.ts')).toBe('export const main = 1;\n');
      expect(warnings).not.toContainEqual(
        expect.objectContaining({ message: expect.stringMatching(/^Restored/) }),
      );
    },
  );
});
