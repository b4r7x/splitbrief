import { describe, expect, it } from 'vitest';
import { apiBaseValidationError } from './api-base.js';

describe('apiBaseValidationError', () => {
  it('does not leak URL credentials', () => {
    const message = apiBaseValidationError('https://alice:secret@example.com/v1');

    expect(message).toBe('Invalid apiBase: must not include credentials');
    expect(message).not.toContain('alice');
    expect(message).not.toContain('secret');
  });
});
