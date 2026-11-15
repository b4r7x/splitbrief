import { describe, expect, it } from 'vitest';
import { shrinkRefusal } from './rewrite-guard.js';

function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n');
}

describe('shrinkRefusal', () => {
  it('leaves a baseline under 5 non-empty lines unguarded', () => {
    expect(shrinkRefusal(lines(4), '')).toBeUndefined();
  });

  it('accepts a candidate that keeps half of the lines', () => {
    expect(shrinkRefusal(lines(10), lines(5))).toBeUndefined();
  });

  it('refuses a candidate that keeps under half of the lines', () => {
    expect(shrinkRefusal(lines(10), lines(4))).toEqual({ kept: 4, had: 10 });
  });

  it('counts only non-empty lines', () => {
    const paddedSmall = ['', '   ', 'a', '', 'b', '  ', 'c', 'd', '   '].join('\n');
    expect(shrinkRefusal(paddedSmall, '')).toBeUndefined();

    const paddedBaseline = [lines(10), '', '   ', '    '].join('\n');
    const paddedCandidate = ['', '  ', lines(4), '', '    ', '  '].join('\n');
    expect(shrinkRefusal(paddedBaseline, paddedCandidate)).toEqual({ kept: 4, had: 10 });
  });
});
