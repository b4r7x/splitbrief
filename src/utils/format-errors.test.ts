import { describe, it, expect } from 'vitest';
import { toErrorMessage, labelError } from './format-errors.js';

describe('toErrorMessage', () => {
  it('converts any value to a string message', () => {
    expect(toErrorMessage(new Error('something broke'))).toBe('something broke');
    expect(toErrorMessage('plain string')).toBe('plain string');
    expect(toErrorMessage(42)).toBe('42');
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage({ message: 'obj' })).toBe('[object Object]');
  });
});

describe('labelError', () => {
  it('prefixes the error message with the action label', () => {
    expect(labelError('Failed to save', new Error('disk full'))).toBe('Failed to save: disk full');
  });
});
