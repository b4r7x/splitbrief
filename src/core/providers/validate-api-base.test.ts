import { describe, expect, it } from 'vitest';
import { validateApiBaseUrl } from './validate-api-base.js';

describe('validateApiBaseUrl', () => {
  it('rejects embedded credentials without echoing them', () => {
    expect(() => validateApiBaseUrl('https://alice:secret@example.com/v1')).toThrow(
      'Invalid apiBase: must not include credentials',
    );

    try {
      validateApiBaseUrl('https://alice:secret@example.com/v1');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('alice');
      expect(message).not.toContain('secret');
    }
  });
});
