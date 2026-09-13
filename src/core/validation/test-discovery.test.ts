import { describe, it, expect } from 'vitest';
import { isTestPatternSafe } from './test-discovery.js';

describe('isTestPatternSafe', () => {
  it('rejects path separators and parent traversal', () => {
    expect(isTestPatternSafe('*.test.ts')).toBe(true);
    expect(isTestPatternSafe('../secret.test.ts')).toBe(false);
    expect(isTestPatternSafe('nested/handler.test.ts')).toBe(false);
    expect(isTestPatternSafe('')).toBe(false);
  });
});
