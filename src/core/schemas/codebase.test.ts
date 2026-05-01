import { describe, it, expect } from 'vitest';
import { CodebaseConfigSchema } from './codebase.js';

describe('CodebaseConfigSchema', () => {
  it('parses with all defaults', () => {
    const result = CodebaseConfigSchema.parse({});
    expect(result).toEqual({ enabled: true, tokenBudget: 4000, cacheDir: '.diptych' });
  });

  it('rejects negative tokenBudget', () => {
    expect(() => CodebaseConfigSchema.parse({ tokenBudget: -1 })).toThrow();
  });

  it('rejects tokenBudget over ceiling', () => {
    expect(() => CodebaseConfigSchema.parse({ tokenBudget: 999_999 })).toThrow();
  });

});
