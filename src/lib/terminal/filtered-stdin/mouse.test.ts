import { describe, it, expect } from 'vitest';
import { readSgrMouse } from './mouse.js';

describe('filtered stdin mouse parsing', () => {
  it('parses a complete SGR wheel-up report', () => {
    const source = Buffer.from('\u001b[<64;10;20M');
    const read = readSgrMouse(source);
    expect(read?.kind).toBe('complete');
    if (read?.kind === 'complete') {
      expect(read.event).toEqual({
        type: 'wheel-up',
        x: 10,
        y: 20,
        button: 64,
        shift: false,
        meta: false,
        ctrl: false,
      });
    }
  });
});
