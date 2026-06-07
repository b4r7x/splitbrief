import { describe, expect, it } from 'vitest';
import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import type { TieredApprovalRequest } from '../../core/approval/types.js';
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

  it('resolves with comment on regenerate', async () => {
    const gate = createApprovalGate();
    const promise = gate.wait();

    expect(gate.handle({ type: 'regenerate', comment: 'needs work' })).toBe(true);

    await expect(promise).resolves.toEqual({ approved: false, comment: 'needs work' });
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
      abort: () => undefined,
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
      abort: () => undefined,
    });

    const response = await callbacks.onTieredApproval?.(confirmRequest);
    expect(response).toEqual({
      decision: 'confirm',
      phrase: CONFIRM_PHRASE,
      reason: 'reviewed diff',
    });
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
