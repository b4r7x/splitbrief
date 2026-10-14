import { describe, expect, it } from 'vitest';
import { checksSummary } from './checks-summary.js';

describe('checksSummary', () => {
  it('says a task ran no checks', () => {
    expect(checksSummary([])).toBe('no checks');
  });

  it('counts passes among the checks that ran and counts the rest apart', () => {
    expect(checksSummary([{ status: 'pass' }, { status: 'pass' }])).toBe('2 of 2 checks passed');
    expect(
      checksSummary([
        { status: 'pass' },
        { status: 'fail' },
        { status: 'refused' },
        { status: 'not-runnable' },
      ]),
    ).toBe('1 of 2 checks passed, 1 refused, 1 not run');
    expect(checksSummary([{ status: 'refused' }])).toBe('1 refused');
  });
});
