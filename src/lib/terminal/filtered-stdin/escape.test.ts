import { describe, it, expect } from 'vitest';
import { readEscape } from './escape.js';
import { PASTE_START_BYTES } from './paste.js';

describe('filtered stdin escape sequences', () => {
  it('holds an incomplete paste start marker prefix', () => {
    const decision = readEscape(Buffer.from('\u001b[200'), false, true);
    expect(decision).toEqual({ kind: 'hold' });
  });

  it('recognizes a complete paste start marker', () => {
    const decision = readEscape(PASTE_START_BYTES, false, true);
    expect(decision).toEqual({ kind: 'paste-start', length: PASTE_START_BYTES.length });
  });
});
