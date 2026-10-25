import { plainUserMessage } from '../../../core/types/user-input.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../core/schemas/config.js';
import type { Task } from '../../../core/schemas/task.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import type { Validator } from '../validation/types.js';
import type { EscalationContext } from './types.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { clearPendingQueue } from '../queue/clear.js';
import { loadState } from '../../../core/state/persistence.js';
import { CORRECTION_AFTER_CHECKS } from '../task/brief-gate.js';
import { validateAndCommit } from './validate-and-commit.js';

let dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('validate-commit-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-validate-commit';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function configWithProfiles(): Config {
  return {
    ...makeNoValidationConfig({
      approval: { feedRejectionsToPlanner: true },
      workflow: { review: 'task' },
    }),
    implementerProfiles: {
      default: 'local-small',
      profiles: {
        'local-small': {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen-small',
          contextLength: 8_192,
        },
      },
    },
  };
}

async function makeValidateCtx(opts: {
  projectDir: string;
  sessionId: string;
  validator: Validator;
  signal?: AbortSignal | undefined;
}): Promise<EscalationContext> {
  return {
    ...makeWctx({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      config: configWithProfiles(),
      validator: opts.validator,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    }),
    taskStartSnapshot: await getChangedFilesSnapshot(opts.projectDir),
    dependsOnFiles: [],
  };
}

describe('validateAndCommit', () => {
  it('completes without an answer when a correction is cleared after recorded checks', async () => {
    const ref = setupProject();
    const task = makeTask({
      id: 'T001',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
    });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    bus.subscribe((event) => {
      if (event.type !== 'checks_run') return;
      const checked = loadState(ref);
      if (checked === null) throw new Error('missing recorded checks');
      clearPendingQueue({ ...ref, state: checked, bus });
    });
    const runCommand = vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
      enqueueUserMessage({
        ...ref,
        state,
        message: plainUserMessage('cleared correction'),
        phase: state.phase,
        bus,
      });
      return { stdout: 'ok', stderr: '', code: 0 };
    });
    const ctx = await makeValidateCtx({
      ...ref,
      validator: { formatChangedFiles: vi.fn().mockResolvedValue(undefined) },
    });

    const result = await validateAndCommit({
      ctx: { ...ctx, bus },
      attemptSnapshot: ctx.taskStartSnapshot,
      task,
      state,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      retryCount: 1,
      preApprovedChangedFiles: [],
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ completed: true });
    expect(result).not.toHaveProperty('answer');
    expect(result.state.tasks[0]?.status).toBe('done');
    expect(result.state.currentTaskIndex).toBe(1);
    expect(result.state.messageQueue).toEqual([]);
    expect(loadState(ref)?.messageQueue).toEqual([]);
    expect(events.filter((event) => event.type === 'task_completed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([]);
  });

  it('returns an answer without completing when a message arrives during green checks', async () => {
    const ref = setupProject();
    const task = makeTask({
      id: 'T001',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
    });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
      enqueueUserMessage({
        ...ref,
        state,
        message: plainUserMessage('keep the public name'),
        phase: state.phase,
        bus,
      });
      return { stdout: 'ok', stderr: '', code: 0 };
    });
    const ctx = await makeValidateCtx({
      ...ref,
      validator: { formatChangedFiles: vi.fn().mockResolvedValue(undefined) },
    });

    const result = await validateAndCommit({
      ctx: { ...ctx, bus },
      attemptSnapshot: ctx.taskStartSnapshot,
      task,
      state,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      retryCount: 1,
      preApprovedChangedFiles: [],
    });

    expect(result).toMatchObject({ completed: false, answer: CORRECTION_AFTER_CHECKS });
    expect(result.state.currentTaskIndex).toBe(0);
    expect(result.state.tasks[0]?.status).not.toBe('done');
    expect(result.state.messageQueue[0]?.drainedAt).toBeUndefined();
    expect(events.filter((event) => event.type === 'task_completed')).toEqual([]);
  });

  it('does not commit retry results when the signal aborts during validation', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T011', suggestedFiles: ['src/abort.ts'] });
    const controller = new AbortController();
    const validator: Validator = {
      formatChangedFiles: vi.fn().mockImplementation(async () => {
        controller.abort(new DOMException('The user aborted a request.', 'AbortError'));
      }),
    };

    const result = await validateAndCommit({
      ctx: await makeValidateCtx({
        projectDir,
        sessionId,
        validator,
        signal: controller.signal,
      }),
      attemptSnapshot: await getChangedFilesSnapshot(projectDir),
      task,
      state: makeImplState([task]),
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      retryCount: 1,
      preApprovedChangedFiles: [task.suggestedFiles[0]],
    });

    expect(result).toMatchObject({
      completed: false,
      blockedReason: 'aborted',
    });
  });

  it('blocks a retry whose required brief check fails', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T013',
      suggestedFiles: ['src/blocks.ts'],
      checks: [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }],
    });
    vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
      processError.exitCode({
        command: 'tsc',
        code: 2,
        stderr: 'src/blocks.ts(1,1): error TS1005',
        output: '',
      }),
    );
    const validator: Validator = { formatChangedFiles: vi.fn().mockResolvedValue(undefined) };

    const result = await validateAndCommit({
      ctx: await makeValidateCtx({ projectDir, sessionId, validator }),
      attemptSnapshot: await getChangedFilesSnapshot(projectDir),
      task,
      state: makeImplState([task]),
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      retryCount: 1,
      preApprovedChangedFiles: [task.suggestedFiles[0]],
    });

    expect(result).toMatchObject({
      completed: false,
      diagnosis: 'check K1 failed',
    });
  });

  describe('a fix task retry', () => {
    const own = 'src/blocks.ts(1,1): error TS1005: ; expected.';
    const other = 'src/other.ts(4,2): error TS1005: ; expected.';
    const fixTask = makeTask({
      id: 'T023',
      suggestedFiles: ['src/blocks.ts'],
      checks: [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }],
      fix: {
        cycle: 1,
        findings: [
          {
            id: 'P1',
            text: 'Required check K1 did not pass',
            acceptance: null,
            checkIds: ['K1'],
            commands: { K1: 'tsc --noEmit' },
            failureKeys: { K1: [own] },
            redKeys: { K1: [own] },
          },
        ],
      },
    });

    async function retry(output: string, others: Task[] = []) {
      const { projectDir, sessionId } = setupProject();
      vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
        processError.exitCode({ command: 'tsc', code: 2, stderr: '', output }),
      );
      const validator: Validator = { formatChangedFiles: vi.fn().mockResolvedValue(undefined) };
      return validateAndCommit({
        ctx: await makeValidateCtx({ projectDir, sessionId, validator }),
        attemptSnapshot: await getChangedFilesSnapshot(projectDir),
        task: fixTask,
        state: makeImplState([fixTask, ...others]),
        method: 'local',
        transitionType: 'VALIDATION_PASS',
        retryCount: 1,
        preApprovedChangedFiles: ['src/blocks.ts'],
      });
    }

    it('completes when its own failure is gone and only a failure it does not own is left', async () => {
      expect(await retry(other)).toMatchObject({ completed: true });
    });

    it('completes when its remaining failure is one a pending sibling carries under a reviewer check of the same command', async () => {
      const sibling = makeTask({
        id: 'T025',
        fix: {
          cycle: 1,
          findings: [
            {
              id: 'V2.1',
              text: 'Reviewer check V2 (tsc --noEmit) failed with new failures.',
              acceptance: null,
              checkIds: ['V2'],
              commands: { V2: 'tsc --noEmit' },
              failureKeys: { V2: [own] },
              redKeys: { V2: [own] },
            },
          ],
        },
      });

      expect(await retry([own, other].join('\n'), [sibling])).toMatchObject({ completed: true });
    });

    it('names its own failure and the others in the diagnosis when its own failure remains', async () => {
      expect(await retry([own, other].join('\n'))).toMatchObject({
        completed: false,
        diagnosis:
          'check K1 failed: your\u00a01\u00a0failure\u00a0remains, 1\u00a0other\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review',
      });
    });
  });
});
