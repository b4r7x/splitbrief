import { describe, expect, it } from 'vitest';
import { escapeTrustLiteral } from './literal.js';

describe('escapeTrustLiteral', () => {
  it('escapes C1 and Unicode line-separator controls as visible literals', () => {
    expect(escapeTrustLiteral('a\u0085b\u2028c\u202ed')).toBe('"a\\u0085b\\u2028c\\u202ed"');
  });
});
