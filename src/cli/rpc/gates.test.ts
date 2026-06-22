import { describe, expect, it, vi } from 'vitest';
import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import type { TieredApprovalRequest } from '../../core/approval/types.js';
import { taskId } from '../../core/schemas/task.js';
import { createWorkflowCallbacks } from './callbacks.js';
import { createApprovalGate, createGate, validateConfirmApprovalFields } from './gates.js';

describe('createApprovalGate', () => {
  it('resolves on approve command', async () => {
    const gate = createApprovalGate();
    const promise = gate.wait();

    expect(gate.handle({ type: 'approve' })).toBe(true);

    await expect(promise).resolves.toEqual({ approved: true });
    expect(gate.isPending()).toBe(false);
  });

  it('resolves regenerate as revise feedback', async () => {
    const gate = createApprovalGate();
    const promise = gate.wait();

    expect(gate.handle({ type: 'regenerate', comment: 'needs work' })).toBe(true);

    await expect(promise).resolves.toEqual({
      approved: false,
      action: 'revise',
      comment: 'needs work',
    });
    expect(gate.isPending()).toBe(false);
  });

  it('resolves as terminal rejection on reject with no comment', async () => {
    const gate = createApprovalGate();
    const promise = gate.wait();

    expect(gate.handle({ type: 'reject' })).toBe(true);

    await expect(promise).resolves.toEqual({ approved: false });
    expect(gate.isPending()).toBe(false);
  });

  it('ignores commands when not pending', () => {
    const gate = createApprovalGate();

    expect(gate.handle({ type: 'approve' })).toBe(false);
    expect(gate.isPending()).toBe(false);
  });

  it('reject causes pending wait to throw', async () => {
    const gate = createApprovalGate();
    const promise = gate.wait();
    const err = new Error('stdin closed');

    expect(gate.reject(err)).toBe(true);
    expect(gate.isPending()).toBe(false);

    await expect(promise).rejects.toThrow('stdin closed');
  });

  it('reject returns false when not pending', () => {
    const gate = createApprovalGate();
    expect(gate.reject(new Error('nope'))).toBe(false);
  });

  it('resolves prompt-scoped brief review commands only for briefs prompts', async () => {
    const gate = createApprovalGate();
    const promise = gate.wait({ approvalType: 'briefs' });
    const prompt = gate.pendingPrompt();

    expect(prompt).toMatchObject({
      promptId: 'approval-1',
      approvalType: 'briefs',
      allowedCommands: [
        'approve',
        'reject',
        'revise',
        'save_draft',
        'external_edit_applied',
        'status',
      ],
    });
    await expect(
      gate.handleBriefReview(
        {
          action: 'revise',
          comment: 'add validation evidence',
          taskIds: [taskId('T001')],
        },
        prompt?.promptId,
      ),
    ).resolves.toEqual({ status: 'settled', prompt });

    await expect(promise).resolves.toEqual({
      approved: false,
      action: 'revise',
      comment: 'add validation evidence',
      taskIds: [taskId('T001')],
    });
  });

  it('runs save_draft without settling the brief review prompt', async () => {
    const gate = createApprovalGate();
    const draft = {
      ok: true,
      qualityPassed: false,
      qualityScore: 0.4,
      issueCount: 2,
      taskCount: 3,
    } as const;
    const promise = gate.wait({ approvalType: 'briefs', onSaveDraft: async () => draft });
    const prompt = gate.pendingPrompt();

    await expect(
      gate.handleBriefReview({ action: 'save_draft' }, prompt?.promptId),
    ).resolves.toEqual({
      status: 'saved',
      prompt,
      draft,
    });
    expect(gate.isPending()).toBe(true);

    await expect(gate.handleBriefReview({ action: 'approve' }, prompt?.promptId)).resolves.toEqual({
      status: 'settled',
      prompt,
    });
    await expect(promise).resolves.toEqual({ approved: true });
  });

  it('rejects prompt-scoped brief review commands for non-brief prompts', async () => {
    const gate = createApprovalGate();
    gate.wait({ approvalType: 'spec' }).catch(() => undefined);

    await expect(gate.handleBriefReview({ action: 'approve' })).resolves.toMatchObject({
      status: 'rejected',
      message: 'Current approval prompt does not accept Task Brief review commands.',
    });
    gate.reject(new Error('done'));
  });
});

describe('validateConfirmApprovalFields', () => {
  it('accepts the exact confirm phrase and a non-empty reason', () => {
    expect(
      validateConfirmApprovalFields({
        confirmationPhrase: CONFIRM_PHRASE,
        confirmationReason: 'ship it',
      }),
    ).toEqual({ ok: true, reason: 'ship it' });
  });

  it('rejects missing phrase, reason, or wrong phrase', () => {
    expect(validateConfirmApprovalFields({ confirmationReason: 'ship it' })).toEqual({ ok: false });
    expect(
      validateConfirmApprovalFields({
        confirmationPhrase: 'wrong phrase',
        confirmationReason: 'ship it',
      }),
    ).toEqual({ ok: false });
    expect(
      validateConfirmApprovalFields({
        confirmationPhrase: CONFIRM_PHRASE,
        confirmationReason: ' ',
      }),
    ).toEqual({ ok: false });
  });
});

describe('createWorkflowCallbacks confirm-tier RPC approval', () => {
  const confirmRequest: TieredApprovalRequest = {
    tier: 'confirm',
    actionClass: 'destructive',
    actionDescription: 'delete files',
    phase: 'implementing',
  };

  it('denies confirm tier when RPC approve omits phrase and reason', async () => {
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({ approved: true }),
      waitForMessage: async () => 'continue',
      reportError: () => undefined,
    });

    const response = await callbacks.onTieredApproval?.(confirmRequest);
    expect(response).toEqual({ decision: 'deny', reason: 'invalid_confirm_phrase' });
  });

  it('accepts confirm tier when RPC approve supplies phrase and reason', async () => {
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({
        approved: true,
        confirmationPhrase: CONFIRM_PHRASE,
        confirmationReason: 'reviewed diff',
      }),
      waitForMessage: async () => 'continue',
      reportError: () => undefined,
    });

    const response = await callbacks.onTieredApproval?.(confirmRequest);
    expect(response).toEqual({
      decision: 'confirm',
      phrase: CONFIRM_PHRASE,
      reason: 'reviewed diff',
    });
  });

  it('passes brief external edits through to the approval re-read loop', async () => {
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({ approved: false, action: 'edit' }),
      waitForMessage: async () => 'continue',
      reportError: () => undefined,
    });

    await expect(callbacks.onApprovalNeeded('briefs', '/tmp/tasks.md')).resolves.toEqual({
      approved: false,
      action: 'edit',
    });
  });

  it('passes targeted brief revision task ids through to the approval loop', async () => {
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({
        approved: false,
        action: 'revise',
        comment: 'focus this brief',
        taskIds: [taskId('T002')],
      }),
      waitForMessage: async () => 'continue',
      reportError: () => undefined,
    });

    await expect(callbacks.onApprovalNeeded('briefs', '/tmp/tasks.md')).resolves.toEqual({
      approved: false,
      action: 'revise',
      comment: 'focus this brief',
      taskIds: [taskId('T002')],
    });
  });

  it('re-prompts task review RPC answers outside availableCommands', async () => {
    const reportError = vi.fn();
    const messages = ['abort', 'continue'];
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({ approved: true }),
      waitForMessage: async () => messages.shift() ?? 'continue',
      reportError,
    });

    await expect(
      callbacks.onTaskReviewNeeded?.({
        taskId: taskId('T001'),
        taskTitle: 'Review RPC command scope',
        status: 'done',
        filesTouched: ['src/task.ts'],
        validation: { passed: true, summary: 'passed', stages: [] },
        evidence: { summary: 'evidence', expected: [], observed: [] },
        cost: {
          tokenUsage: {
            plannerInput: 0,
            plannerOutput: 0,
            implementerInput: 0,
            implementerOutput: 0,
            escalationInput: 0,
            escalationOutput: 0,
          },
        },
        availableCommands: ['continue'],
      }),
    ).resolves.toEqual({ action: 'continue' });
    expect(reportError).toHaveBeenCalledWith('Invalid task review response. Use: continue.');
  });

  it('returns advertised task review abort over RPC without host side effects', async () => {
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({ approved: true }),
      waitForMessage: async () => 'abort',
      reportError: () => undefined,
    });

    await expect(
      callbacks.onTaskReviewNeeded?.({
        taskId: taskId('T001'),
        taskTitle: 'Review RPC abort',
        status: 'done',
        filesTouched: ['src/task.ts'],
        validation: { passed: true, summary: 'passed', stages: [] },
        evidence: { summary: 'evidence', expected: [], observed: [] },
        cost: {
          tokenUsage: {
            plannerInput: 0,
            plannerOutput: 0,
            implementerInput: 0,
            implementerOutput: 0,
            escalationInput: 0,
            escalationOutput: 0,
          },
        },
        availableCommands: ['continue', 'abort'],
      }),
    ).resolves.toEqual({ action: 'abort' });
  });

  it('accepts advertised task review notes over RPC', async () => {
    const callbacks = createWorkflowCallbacks({
      waitForApproval: async () => ({ approved: true }),
      waitForMessage: async () => 'notes keep this context',
      reportError: () => undefined,
    });

    await expect(
      callbacks.onTaskReviewNeeded?.({
        taskId: taskId('T001'),
        taskTitle: 'Review RPC notes',
        status: 'done',
        filesTouched: ['src/task.ts'],
        validation: { passed: true, summary: 'passed', stages: [] },
        evidence: { summary: 'evidence', expected: [], observed: [] },
        cost: {
          tokenUsage: {
            plannerInput: 0,
            plannerOutput: 0,
            implementerInput: 0,
            implementerOutput: 0,
            escalationInput: 0,
            escalationOutput: 0,
          },
        },
        availableCommands: ['continue', 'edit-notes'],
      }),
    ).resolves.toEqual({ action: 'continue', notes: 'keep this context' });
  });
});

describe('createGate', () => {
  it('reject causes pending wait to throw', async () => {
    const gate = createGate<string>();
    const promise = gate.wait();
    const err = new Error('connection lost');

    expect(gate.reject(err)).toBe(true);
    expect(gate.isPending()).toBe(false);

    await expect(promise).rejects.toThrow('connection lost');
  });

  it('reject returns false when not pending', () => {
    const gate = createGate<string>();
    expect(gate.reject(new Error('nope'))).toBe(false);
  });

  it('resolve still works after adding reject', async () => {
    const gate = createGate<string>();
    const promise = gate.wait();

    expect(gate.resolve('value')).toBe(true);
    await expect(promise).resolves.toBe('value');
  });
});
