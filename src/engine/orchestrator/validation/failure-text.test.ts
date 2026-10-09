import { describe, expect, it } from 'vitest';
import { failureKeys } from './extract-failure-keys.js';
import { checkFailureText } from './failure-text.js';
import type { CheckRunResult } from './run-checks.js';
import { boundedOutputTail } from './stage.js';

const NOISE = Array.from(
  { length: 200 },
  (_line, index) => `{"type":"task_end","id":${index},"endedAt":1760000000000,"durationMs":63}`,
).join('\n');

function red(text: string): CheckRunResult {
  return {
    checkId: 'V1',
    status: 'fail',
    output: boundedOutputTail(text),
    failure: failureKeys({ capture: { text, complete: true }, exitCode: 1 }, '/repo'),
    command: 'npm run test-ci',
    exitCode: 1,
  };
}

describe('checkFailureText', () => {
  // Live run 2026-10-09: the 4k tail of `npm run test-ci` was an event-log line.
  it('names the failing test and its assertion message when the output tail is noise', () => {
    const run = red(
      [
        ' FAIL  src/a.test.ts > a > adds',
        'AssertionError: expected 1 to be 2',
        ' ❯ src/a.test.ts:3:5',
        NOISE,
      ].join('\n'),
    );
    expect(run.output).not.toContain('AssertionError');

    const text = checkFailureText(run);

    expect(text).toMatch(/^check V1 did not pass \(fail\): 1 failure\n/);
    expect(text).toContain(
      'Failures:\n- src/a.test.ts::a > adds\n  AssertionError: expected 1 to be 2\nOutput tail:\n',
    );
    expect(text.indexOf('AssertionError')).toBeLessThan(text.indexOf('Output tail:'));
  });

  it('lists a diagnostic key as its own line', () => {
    const diagnostic = 'src/b.ts(4,2): error TS2322: Type number is not assignable to type string.';

    expect(checkFailureText(red(`${diagnostic}\n${NOISE}`))).toContain(
      `Failures:\n- ${diagnostic}\nOutput tail:\n`,
    );
  });

  it('lists at most ten keys and counts the rest', () => {
    const lines = Array.from(
      { length: 12 },
      (_line, index) => `src/c${index}.ts(1,1): error TS2304: Cannot find name x.`,
    );
    const text = checkFailureText(red(lines.join('\n')));

    expect(text).toContain('12 failures');
    expect(text).toContain('- src/c9.ts(1,1)');
    expect(text).not.toContain('- src/c10.ts(1,1)');
    expect(text).toContain('and 2 more\nOutput tail:');
  });

  it('keeps the output of a red that names no failure', () => {
    expect(checkFailureText(red('broken'))).toBe('check V1 did not pass (fail): broken');
  });

  it('keeps the output of a check that could not run', () => {
    expect(checkFailureText({ checkId: 'V2', status: 'refused', output: 'names no program' })).toBe(
      'check V2 did not pass (refused): names no program',
    );
  });

  it('names the fix task keys that remain before the other failures', () => {
    const own = 'src/a.test.ts::a > adds';
    const gone = 'src/d.ts(2,1): error TS2322: Type number is not assignable to type string.';
    const other = 'src/legacy.ts(3,7): error TS2322: Type number is not assignable to type string.';
    const run = red(
      [' FAIL  src/a.test.ts > a > adds', 'AssertionError: expected 1 to be 2', other, NOISE].join(
        '\n',
      ),
    );

    const text = checkFailureText(run, { failureKeys: [own, gone], redKeys: [own, gone, other] });

    expect(text).toMatch(/^check V1 did not pass \(fail\): 1 of your 2 failures remains\n/);
    expect(text).toContain(
      [
        'Your failures that remain:',
        `- ${own}`,
        '  AssertionError: expected 1 to be 2',
        'Other failures:',
        `- ${other}`,
        'Output tail:',
      ].join('\n'),
    );
    expect(text).not.toContain(gone);
  });

  it('lists a moved diagnostic the fix task owns at its new line', () => {
    const carried = 'src/a.ts(1,14): error TS2322: Type number is not assignable to type string.';
    const moved = 'src/a.ts(5,14): error TS2322: Type number is not assignable to type string.';

    const text = checkFailureText(red(moved), { failureKeys: [carried], redKeys: [carried] });

    expect(text).toContain(`your 1 failure remains\nYour failures that remain:\n- ${moved}`);
  });
});
