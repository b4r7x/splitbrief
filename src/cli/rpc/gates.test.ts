import { describe, expect, it } from 'vitest';
import { createApprovalGate, createGate } from './gates.js';

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
