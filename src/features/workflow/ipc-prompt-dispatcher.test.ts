import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { IpcPromptRequest } from '../../engine/ipc/protocol.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import { allowedSettlingBriefReviewCommandsForPrompt } from '../../core/schemas/brief-review-command.js';
import { taskId } from '../../core/schemas/task.js';
import { SESSION_FILE_PATH_MAX_BYTES } from '../../core/sessions/confinement.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { reviewStore } from '../../stores/workflow/review.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import {
  createIpcPromptDispatcher,
  formatIpcRecoveryPrompt,
  parseIpcRecoveryAction,
} from './ipc-prompt-dispatcher.js';

const budgetPausedIssue = {
  id: 'rec-budget',
  reason: 'budget-paused' as const,
  phase: 'implementing' as const,
  taskId: taskId('T001'),
  taskTitle: 'Finish checkout',
  files: ['src/checkout.ts'],
  affectedTaskIds: [taskId('T001')],
  selectedImplementerProfile: 'local-small',
  availableActions: [
    'continue' as const,
    'skip-current-task' as const,
    'pause-run' as const,
    'abort-workflow' as const,
  ],
  recommendedAction: 'continue' as const,
  workerProfile: 'local-large',
  facts: { safeToContinue: true },
};

const tmpDirs: string[] = [];
const itUnix = process.platform === 'win32' ? it.skip : it;

function inputModeWith(prompts: string[], answer: string | string[]): UseInputModeResult {
  const answers = Array.isArray(answer) ? [...answer] : [answer];
  return {
    mode: 'normal',
    hint: '',
    setReviewMode: async () => ({ approved: false }),
    setQuestionMode: async (prompt: string) => {
      prompts.push(prompt);
      return answers.shift() ?? '';
    },
    resolve: () => {},
    resetMode: () => {},
  };
}

function reviewInputMode(
  reviewPaths: string[],
  result: ApprovalReviewResult = { approved: true },
): UseInputModeResult {
  return {
    mode: 'normal',
    hint: '',
    setReviewMode: async () => {
      reviewPaths.push(reviewStore.get().filePath ?? '');
      return result;
    },
    setQuestionMode: async () => '',
    resolve: () => {},
    resetMode: () => {},
  };
}

function makeSessionDir(): string {
  const root = createTempDir('ipc-prompt-dispatcher');
  tmpDirs.push(root);
  const sessionDir = join(root, '.diptych', 'sessions', 'session-1');
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function approvalRequest(filePath: string): IpcPromptRequest {
  return {
    requestId: 'approval-1',
    kind: 'approval_needed',
    approvalType: 'spec',
    filePath,
    allowedCommands: [],
  };
}

afterEach(() => {
  reviewStore.clearReview();
  feedbackStore.reset();
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

describe('formatIpcRecoveryPrompt', () => {
  it('presents every available action, not a binary retry/abort', () => {
    const prompt = formatIpcRecoveryPrompt(budgetPausedIssue);

    expect(prompt).toContain('Recovery needed: budget-paused');
    expect(prompt).toContain('Task: T001 - Finish checkout');
    expect(prompt).toContain('Files: src/checkout.ts');
    expect(prompt).toContain('Worker: local-large');
    expect(prompt).toContain('Recommended: continue');
    expect(prompt).toContain('[c] continue');
    expect(prompt).toContain('[s] skip task');
    expect(prompt).toContain('[space] pause');
    expect(prompt).toContain('[a] abort');
    expect(prompt).not.toContain('retry / abort');
  });
});

describe('parseIpcRecoveryAction', () => {
  it('maps aliases to actions confined to availableActions', () => {
    expect(parseIpcRecoveryAction('c', budgetPausedIssue)).toBe('continue');
    expect(parseIpcRecoveryAction('skip', budgetPausedIssue)).toBe('skip-current-task');
    expect(parseIpcRecoveryAction('abort', budgetPausedIssue)).toBe('abort-workflow');
    expect(parseIpcRecoveryAction('space', budgetPausedIssue)).toBe('pause-run');
  });

  it('rejects unavailable or unknown answers', () => {
    expect(parseIpcRecoveryAction('r', budgetPausedIssue)).toBeNull();
    expect(parseIpcRecoveryAction('wat', budgetPausedIssue)).toBeNull();
    expect(parseIpcRecoveryAction(' ', budgetPausedIssue)).toBe('pause-run');
  });

  it('rejects unknown answers when pause is not offered', () => {
    const issue = {
      id: 'rec-budget-exceeded',
      reason: 'budget-exceeded' as const,
      phase: 'implementing' as const,
      files: [],
      affectedTaskIds: [],
      availableActions: ['abort-workflow' as const],
      recommendedAction: 'abort-workflow' as const,
    };
    expect(parseIpcRecoveryAction('wat', issue)).toBeNull();
  });
});

describe('createIpcPromptDispatcher recovery_needed', () => {
  it('routes recovery to a question prompt and returns the chosen action', async () => {
    const prompts: string[] = [];
    const dispatch = createIpcPromptDispatcher(inputModeWith(prompts, 'skip'));

    const request: IpcPromptRequest = {
      requestId: 'req_1',
      kind: 'recovery_needed',
      issue: budgetPausedIssue,
    };
    const response = await dispatch(request);

    expect(response).toEqual({ kind: 'recovery_needed', action: 'skip-current-task' });
    expect(prompts[0]).toContain('[s] skip task');
    expect(prompts[0]).toContain('[c] continue');
  });

  it('re-prompts instead of coercing an unknown recovery answer', async () => {
    const prompts: string[] = [];
    const dispatch = createIpcPromptDispatcher(inputModeWith(prompts, ['wat', ' ']));

    const response = await dispatch({
      requestId: 'req_2',
      kind: 'recovery_needed',
      issue: budgetPausedIssue,
    });

    expect(response).toEqual({ kind: 'recovery_needed', action: 'pause-run' });
    expect(prompts).toHaveLength(2);
    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: 'Unknown recovery action.',
    });
  });
});

describe('createIpcPromptDispatcher approval_needed path confinement', () => {
  it('opens review mode for a valid session-relative artifact path', async () => {
    const sessionDir = makeSessionDir();
    const specPath = join(sessionDir, 'spec.md');
    writeFileSync(specPath, '# spec\n');
    const calls: string[] = [];
    const dispatch = createIpcPromptDispatcher(reviewInputMode(calls), {
      sessionDirPath: sessionDir,
    });

    const response = await dispatch(approvalRequest('spec.md'));

    expect(response).toEqual({ kind: 'approval_needed', approved: true });
    expect(calls).toEqual([specPath]);
    expect(reviewStore.get().filePath).toBeNull();
  });

  it('maps external edit completion to the approval edit response used by the re-read loop', async () => {
    const sessionDir = makeSessionDir();
    const tasksPath = join(sessionDir, 'tasks.md');
    writeFileSync(tasksPath, '# tasks\n');
    const calls: string[] = [];
    const dispatch = createIpcPromptDispatcher(
      reviewInputMode(calls, { approved: false, action: 'edit' }),
      {
        sessionDirPath: sessionDir,
      },
    );

    const response = await dispatch({
      requestId: 'approval-briefs',
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: 'tasks.md',
      allowedCommands: [...allowedSettlingBriefReviewCommandsForPrompt('briefs')],
    });

    expect(response).toEqual({ kind: 'approval_needed', approved: false, action: 'edit' });
    expect(calls).toEqual([tasksPath]);
  });

  it('rejects escaped, control-character, and oversized approval paths before review state changes', async () => {
    const sessionDir = makeSessionDir();
    const outside = join(sessionDir, '..', 'outside.md');
    writeFileSync(outside, 'outside');
    const calls: string[] = [];
    const dispatch = createIpcPromptDispatcher(reviewInputMode(calls), {
      sessionDirPath: sessionDir,
    });

    for (const filePath of [
      '../outside.md',
      `spec\u001b[31m.md`,
      `${'x'.repeat(SESSION_FILE_PATH_MAX_BYTES + 1)}.md`,
    ]) {
      const response = await dispatch(approvalRequest(filePath));
      expect(response).toEqual({ kind: 'approval_needed', approved: false });
      expect(reviewStore.get().filePath).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  itUnix('rejects symlinked approval paths before review state changes', async () => {
    const sessionDir = makeSessionDir();
    const outsideRoot = createTempDir('ipc-prompt-dispatcher-outside');
    tmpDirs.push(outsideRoot);
    const outsideFile = join(outsideRoot, 'outside.md');
    writeFileSync(outsideFile, 'outside');
    symlinkSync(outsideFile, join(sessionDir, 'spec.md'));
    const calls: string[] = [];
    const dispatch = createIpcPromptDispatcher(reviewInputMode(calls), {
      sessionDirPath: sessionDir,
    });

    const response = await dispatch(approvalRequest('spec.md'));

    expect(response).toEqual({ kind: 'approval_needed', approved: false });
    expect(reviewStore.get().filePath).toBeNull();
    expect(calls).toHaveLength(0);
  });

  itUnix(
    'rejects approval paths through symlinked directories before review state changes',
    async () => {
      const sessionDir = makeSessionDir();
      const realDir = join(sessionDir, 'real');
      mkdirSync(realDir);
      writeFileSync(join(realDir, 'spec.md'), '# spec\n');
      symlinkSync(realDir, join(sessionDir, 'link'));
      const calls: string[] = [];
      const dispatch = createIpcPromptDispatcher(reviewInputMode(calls), {
        sessionDirPath: sessionDir,
      });

      const response = await dispatch(approvalRequest('link/spec.md'));

      expect(response).toEqual({ kind: 'approval_needed', approved: false });
      expect(reviewStore.get().filePath).toBeNull();
      expect(calls).toHaveLength(0);
    },
  );
});

describe('createIpcPromptDispatcher task_review', () => {
  it('uses the full task-review prompt and re-prompts on unavailable commands', async () => {
    const prompts: string[] = [];
    const dispatch = createIpcPromptDispatcher(inputModeWith(prompts, ['abort', 'continue']));

    const response = await dispatch({
      requestId: 'review-1',
      kind: 'task_review',
      request: {
        taskId: taskId('T001'),
        taskTitle: 'Attached task',
        status: 'done',
        filesTouched: ['src/attached.ts'],
        validation: { passed: true, summary: 'validation passed', stages: [] },
        evidence: { summary: 'evidence recorded', expected: [], observed: [] },
        cost: {
          tokenUsage: {
            plannerInput: 0,
            plannerOutput: 0,
            implementerInput: 10,
            implementerOutput: 5,
            escalationInput: 0,
            escalationOutput: 0,
          },
        },
        availableCommands: ['continue'],
      },
    });

    expect(response).toEqual({
      kind: 'task_review',
      response: { action: 'continue' },
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Task review: T001 - Attached task');
    expect(prompts[0]).toContain('Status: done');
    expect(prompts[0]).toContain('Files: src/attached.ts');
    expect(prompts[0]).toContain('Commands: continue');
    expect(prompts[0]).not.toContain('abort');
    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: 'Unrecognized task review command. Use: continue.',
    });
  });
});
