import { describe, expect, it } from 'vitest';
import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import { taskId } from '../../core/schemas/task.js';
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
    const promise = gate.wait({ approvalType: 'briefs' });
    expect(gate.pendingPrompt()).not.toBeNull();
    const err = new Error('stdin closed');

    expect(gate.reject(err)).toBe(true);
    expect(gate.pendingPrompt()).toBeNull();

    await expect(promise).rejects.toThrow('stdin closed');
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

  it('keeps artifact text only in its live generic approval prompt', async () => {
    const gate = createApprovalGate();
    const review = Object.freeze({
      label: 'Custom planner artifact',
      text: '# immutable artifact\n\u0000preserve exactly\n',
    });
    const pending = gate.wait({ approvalType: 'artifact', artifactReview: review });

    expect(gate.pendingPrompt()).toEqual({
      promptId: 'approval-1',
      approvalType: 'artifact',
      allowedCommands: [],
      artifactReview: review,
    });
    await expect(gate.handleBriefReview({ action: 'approve' })).resolves.toMatchObject({
      status: 'rejected',
      message: 'Current approval prompt does not accept Task Brief review commands.',
    });

    expect(gate.handle({ type: 'approve' })).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true });
    expect(gate.pendingPrompt()).toBeNull();
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
