import { describe, expect, it } from 'vitest';
import type { IpcPromptRequest } from '../../engine/ipc/protocol.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import {
  createIpcPromptDispatcher,
  formatIpcRecoveryPrompt,
  parseIpcRecoveryAction,
} from './ipc-prompt-dispatcher.js';

const budgetPausedIssue = {
  reason: 'budget-paused' as const,
  message: 'Budget pause at 87%',
  availableActions: [
    'continue' as const,
    'skip-current-task' as const,
    'pause-run' as const,
    'abort-workflow' as const,
  ],
  recommendedAction: 'continue' as const,
};

function inputModeWith(prompts: string[], answer: string): UseInputModeResult {
  return {
    mode: 'normal',
    hint: '',
    setReviewMode: async () => ({ approved: false }),
    setQuestionMode: async (prompt: string) => {
      prompts.push(prompt);
      return answer;
    },
    resolve: () => {},
    resetMode: () => {},
  };
}

describe('formatIpcRecoveryPrompt', () => {
  it('presents every available action, not a binary retry/abort', () => {
    const prompt = formatIpcRecoveryPrompt(budgetPausedIssue);

    expect(prompt).toContain('Recovery needed: Budget pause at 87%');
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

  it('falls back to pause for unavailable or unknown answers', () => {
    expect(parseIpcRecoveryAction('r', budgetPausedIssue)).toBe('pause-run');
    expect(parseIpcRecoveryAction('wat', budgetPausedIssue)).toBe('pause-run');
    expect(parseIpcRecoveryAction(' ', budgetPausedIssue)).toBe('pause-run');
  });

  it('falls back to the recommended action when pause is not offered', () => {
    const issue = {
      reason: 'budget-exceeded' as const,
      message: 'Budget exceeded',
      availableActions: ['abort-workflow' as const],
      recommendedAction: 'abort-workflow' as const,
    };
    expect(parseIpcRecoveryAction('wat', issue)).toBe('abort-workflow');
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

  it('does not coerce a non-retry issue into retry-same-worker', async () => {
    const prompts: string[] = [];
    const dispatch = createIpcPromptDispatcher(inputModeWith(prompts, ''));

    const response = await dispatch({
      requestId: 'req_2',
      kind: 'recovery_needed',
      issue: budgetPausedIssue,
    });

    expect(response).toEqual({ kind: 'recovery_needed', action: 'pause-run' });
  });
});
