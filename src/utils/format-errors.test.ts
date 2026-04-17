import { describe, it, expect } from 'vitest';
import { toErrorMessage } from './format-errors.js';

describe('toErrorMessage', () => {
  it('extracts message from Error object', () => {
    expect(toErrorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('converts string to string', () => {
    expect(toErrorMessage('plain string')).toBe('plain string');
  });

  it('converts unknown type to string representation', () => {
    expect(toErrorMessage(42)).toBe('42');
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage(undefined)).toBe('undefined');
  });
});
