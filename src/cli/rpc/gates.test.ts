import { describe, expect, it } from 'vitest';
import { createApprovalGate } from './gates.js';

describe('createApprovalGate', () => {
  it('resolves on approve command', async () => {
    const gate = createApprovalGate();
    const promise = gate.wait();

    expect(gate.handle({ type: 'approve' })).toBe(true);

    await expect(promise).resolves.toEqual({ approved: true });
    expect(gate.isPending()).toBe(false);
  });

  it('resolves with comment on reject', async () => {
    const gate = createApprovalGate();
    const promise = gate.wait();

    expect(gate.handle({ type: 'reject', comment: 'needs work' })).toBe(true);

    await expect(promise).resolves.toEqual({ approved: false, comment: 'needs work' });
    expect(gate.isPending()).toBe(false);
  });

  it('ignores commands when not pending', () => {
    const gate = createApprovalGate();

    expect(gate.handle({ type: 'approve' })).toBe(false);
    expect(gate.isPending()).toBe(false);
  });
});
