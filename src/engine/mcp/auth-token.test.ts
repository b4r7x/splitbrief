import { describe, it, expect } from 'vitest';
import { generateToken } from './auth-token.js';

describe('generateToken', () => {
  it('returns a non-empty string', () => {
    expect(generateToken()).toBeTruthy();
    expect(typeof generateToken()).toBe('string');
  });

  it('returns different values on successive calls', () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});
