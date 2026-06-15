import { describe, expect, it } from 'vitest';
import { validateApiBaseUrl } from './validate-api-base.js';

function caught(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected function to throw');
}

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

  it('throws a kind-tagged error for a non-absolute apiBase', () => {
    const err = caught(() => validateApiBaseUrl('not-a-url'));
    expect(err).toMatchObject({
      kind: 'api-base-not-absolute',
      message: 'Invalid apiBase: must be an absolute URL',
    });
  });

  it('throws a kind-tagged error for embedded credentials', () => {
    const err = caught(() => validateApiBaseUrl('https://alice:secret@example.com/v1'));
    expect(err).toMatchObject({
      kind: 'api-base-has-credentials',
      message: 'Invalid apiBase: must not include credentials',
    });
  });

  it('throws a kind-tagged error for a non-http protocol', () => {
    const err = caught(() => validateApiBaseUrl('ftp://example.com/v1'));
    expect(err).toMatchObject({
      kind: 'api-base-bad-protocol',
      message: 'Invalid apiBase: must use http or https',
    });
  });
});
