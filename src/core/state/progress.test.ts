import { describe, it, expect } from 'vitest';
import { sameFailure } from './progress.js';

const typeError = [{ source: 'check V1', keys: ['src/a.ts(3,1): error TS2322'] }];

describe('sameFailure', () => {
  it('is the same failure when the same diagnostic only moved its line', () => {
    const moved = [{ source: 'check V1', keys: ['src/a.ts(9,4): error TS2322'] }];
    expect(sameFailure(typeError, moved)).toBe(true);
  });

  it('is a moved failure when a key is new, a key is gone, or another check fails', () => {
    const more = [
      {
        source: 'check V1',
        keys: ['src/a.ts(3,1): error TS2322', 'src/b.ts(1,1): error TS2304'],
      },
    ];
    const other = [{ source: 'check V2', keys: ['src/a.ts(3,1): error TS2322'] }];
    expect(sameFailure(typeError, more)).toBe(false);
    expect(sameFailure(more, typeError)).toBe(false);
    expect(sameFailure(typeError, other)).toBe(false);
  });
});
