import { describe, expect, it } from 'vitest';
import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import {
  BriefReviewCommandSchema,
  isBriefReviewCommandCurrent,
  type BriefReviewCommand,
} from '../../core/schemas/brief-review-command.js';
import { BriefRecoveryProjectionV1Schema } from '../../core/schemas/brief-recovery.js';
import { createApprovalGate, createGate, validateConfirmApprovalFields } from './gates.js';

const commandIdentity = {
  version: 1 as const,
  sessionId: 'session-1',
  epochId: 'epoch-1',
  operationId: 'operation-1',
  expectedBriefRevision: 2,
  expectedReportRevision: 3,
  intentHash: 'intent-1',
  base: { revision: 2, hash: 'brief-hash', path: 'tasks.md' },
  baseReport: { revision: 3, hash: 'report-hash', path: 'brief-quality.json' },
};

function reviewCommand(action: BriefReviewCommand['action']): BriefReviewCommand {
  if (action === 'status') {
    return BriefReviewCommandSchema.parse({
      version: 1,
      sessionId: commandIdentity.sessionId,
      epochId: commandIdentity.epochId,
      action,
    });
  }

  const fields =
    action === 'retry'
      ? { diagnosticFingerprint: 'diagnostic-1', frozenInputIds: [] }
      : action === 'edit'
        ? { briefText: '# Updated Brief', newInputId: 'input-1' }
        : action === 'reject'
          ? { userIntentId: 'intent-1' }
          : action === 'comment'
            ? { comment: 'add validation evidence' }
            : action === 'resolve-unresolved'
              ? {
                  heldInputIds: ['input-1'],
                  resolution: { kind: 'abandon' as const },
                }
              : {};

  return BriefReviewCommandSchema.parse({ ...commandIdentity, action, ...fields });
}

function recoveryProjection() {
  return BriefRecoveryProjectionV1Schema.parse({
    version: 1,
    sessionId: commandIdentity.sessionId,
    stateRevision: 4,
    recoveryRevision: 2,
    epochId: commandIdentity.epochId,
    status: 'blocked',
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief: null,
    matchingReport: null,
    blocker: null,
    allowedActions: ['status'],
    activeOperation: null,
    latestAttempt: null,
    queuedInputs: { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
  });
}

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
        'retry',
        'edit',
        'reject',
        'approve',
        'comment',
        'import',
        'resolve-unresolved',
        'status',
      ],
    });
    await expect(
      gate.handleBriefReview(reviewCommand('comment'), prompt?.promptId),
    ).resolves.toEqual({ status: 'settled', prompt });

    await expect(promise).resolves.toEqual({
      approved: false,
      action: 'revise',
      comment: 'add validation evidence',
    });
  });

  it('keeps comment-free retry pending with a stable refusal', async () => {
    const gate = createApprovalGate();
    const promise = gate.wait({ approvalType: 'briefs' });
    const prompt = gate.pendingPrompt();

    await expect(gate.handleBriefReview(reviewCommand('retry'), prompt?.promptId)).resolves.toEqual(
      {
        status: 'rejected',
        prompt,
        message: 'Task Brief review command does not resolve the prompt.',
      },
    );
    expect(gate.isPending()).toBe(true);

    await expect(
      gate.handleBriefReview(reviewCommand('approve'), prompt?.promptId),
    ).resolves.toEqual({
      status: 'settled',
      prompt,
    });
    await expect(promise).resolves.toEqual({ approved: true });
  });

  it.each(['retry', 'import', 'resolve-unresolved'] as const)(
    'refuses non-settling %s commands with stable prompt state',
    async (action) => {
      const gate = createApprovalGate();
      const promise = gate.wait({ approvalType: 'briefs' });
      const prompt = gate.pendingPrompt();

      await expect(
        gate.handleBriefReview(reviewCommand(action), prompt?.promptId),
      ).resolves.toEqual({
        status: 'rejected',
        prompt,
        message: 'Task Brief review command does not resolve the prompt.',
      });
      expect(gate.isPending()).toBe(true);
      expect(gate.reject(new Error('test cleanup'))).toBe(true);
      await expect(promise).rejects.toThrow('test cleanup');
    },
  );

  it('rejects duplicate held-input IDs before dispatch', () => {
    const retry = reviewCommand('retry');
    expect(
      BriefReviewCommandSchema.safeParse({
        ...retry,
        frozenInputIds: ['input-1', 'input-1'],
      }).success,
    ).toBe(false);
  });

  it('rejects a stale command epoch without changing the current projection', async () => {
    const projection = recoveryProjection();
    const stale = { ...reviewCommand('status'), epochId: 'epoch-old' };

    expect(isBriefReviewCommandCurrent(stale, projection)).toBe(false);
    expect(isBriefReviewCommandCurrent(reviewCommand('status'), projection)).toBe(true);

    const gate = createApprovalGate({ getBriefReviewProjection: () => projection });
    const promise = gate.wait({ approvalType: 'briefs' });
    const prompt = gate.pendingPrompt();
    await expect(
      gate.handleBriefReview({ ...reviewCommand('retry'), epochId: 'epoch-old' }, prompt?.promptId),
    ).resolves.toEqual({
      status: 'rejected',
      prompt,
      message: 'Task Brief review command is stale.',
    });
    expect(gate.isPending()).toBe(true);
    expect(gate.reject(new Error('test cleanup'))).toBe(true);
    await expect(promise).rejects.toThrow('test cleanup');
  });

  it('rejects prompt-scoped brief review commands for non-brief prompts', async () => {
    const gate = createApprovalGate();
    gate.wait({ approvalType: 'spec' }).catch(() => undefined);

    await expect(gate.handleBriefReview(reviewCommand('approve'))).resolves.toMatchObject({
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
    await expect(gate.handleBriefReview(reviewCommand('approve'))).resolves.toMatchObject({
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
