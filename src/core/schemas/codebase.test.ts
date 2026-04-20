import { describe, it, expect } from 'vitest';
import { CodebaseConfigSchema } from './codebase.js';

describe('CodebaseConfigSchema', () => {
  it('parses with all defaults', () => {
    const result = CodebaseConfigSchema.parse({});
    expect(result).toEqual({ enabled: true, tokenBudget: 4000, cacheDir: '.diptych' });
  });

  it('parses a fully specified config', () => {
    const result = CodebaseConfigSchema.parse({
      enabled: false,
      tokenBudget: 8000,
      cacheDir: '/tmp',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
    });
    expect(result).toEqual({
      enabled: false, tokenBudget: 8000, cacheDir: '/tmp',
      include: ['src/**/*.ts'], exclude: ['**/*.test.ts'],
    });
  });

  it('rejects negative tokenBudget', () => {
    expect(() => CodebaseConfigSchema.parse({ tokenBudget: -1 })).toThrow();
  });

  it('rejects tokenBudget over ceiling', () => {
    expect(() => CodebaseConfigSchema.parse({ tokenBudget: 999_999 })).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => CodebaseConfigSchema.parse({ enabled: true, unknownField: 'x' })).toThrow();
  });
});
