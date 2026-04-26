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

  it('returns only base64url characters', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns exactly 43 characters for 32 bytes', () => {
    expect(generateToken()).toHaveLength(43);
  });
});
