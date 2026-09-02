import { describe, it, expect } from 'vitest';
import { generateToken } from './auth-token.js';

describe('generateToken', () => {
  it('returns a fresh 256-bit url-safe token per call', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(generateToken());
  });
});
