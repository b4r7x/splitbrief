import { describe, it, expect } from 'vitest';
import { sanitizePasteBody } from './paste.js';

describe('filtered stdin paste sanitization', () => {
  it('folds CRLF to LF and strips embedded escapes', () => {
    expect(sanitizePasteBody('a\r\nb\u001b[Cc')).toBe('a\nbc');
  });
});
