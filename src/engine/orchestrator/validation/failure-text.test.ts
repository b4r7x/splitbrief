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
    expect(checkFailureText(red(''))).toBe(
      'check V1 did not pass (fail): exited with code 1 without diagnostics',
    );
  });

  it('clips and redacts listed keys and messages before the bounded tail', () => {
    const text = checkFailureText(
      red(
        [
          ` FAIL  src/a.test.ts > API_KEY="test-key" ${'x'.repeat(400)}`,
          `AssertionError: PASSWORD="test-password" ${'y'.repeat(400)}`,
          NOISE,
        ].join('\n'),
      ),
    );
    const listing = text.split('Output tail:')[0] ?? '';

    expect(listing).toContain('API_KEY="***REDACTED***"');
    expect(listing).toContain('PASSWORD="***REDACTED***"');
    expect(text).not.toContain('test-key');
    expect(text).not.toContain('test-password');
    for (const line of listing.split('\n').filter((line) => /^- |^ {2}/.test(line))) {
      expect(line.length).toBeLessThanOrEqual(302);
    }
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

    const text = checkFailureText(run, {
      carried: { failureKeys: [own, gone], redKeys: [own, gone, other] },
    });

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

    const text = checkFailureText(red(moved), {
      carried: { failureKeys: [carried], redKeys: [carried] },
    });

    expect(text).toContain(`your 1 failure remains\nYour failures that remain:\n- ${moved}`);
  });

  it('shares ten places between Go tests and diagnostics, keeping each listed test message', () => {
    const run = red(
      [
        ...Array.from(
          { length: 10 },
          (_line, index) =>
            `--- FAIL: Test${index} (0.00s)\n    x_test.go:${index + 1}: got ${index}, want 20`,
        ),
        NOISE,
      ].join('\n'),
    );
    const text = checkFailureText(run);
    const listing = text.split('Output tail:')[0] ?? '';

    expect(run.output).not.toContain('got');
    expect(listing).toContain('20 failures');
    expect(listing.match(/^- Test\d+$/gm)).toHaveLength(5);
    expect(listing.match(/^- x_test.go:/gm)).toHaveLength(5);
    for (let index = 0; index < 5; index++) {
      expect(listing).toContain(`- Test${index}\n  x_test.go:${index + 1}: got ${index}, want 20`);
    }
    expect(listing).toContain('and 10 more');
    expect(text.endsWith(run.output)).toBe(true);
  });

  it('uses spare diagnostic places for tests without excluding the one diagnostic', () => {
    const text = checkFailureText(
      red(
        [
          ...Array.from(
            { length: 10 },
            (_line, index) =>
              ` FAIL  src/a.test.ts > test ${index}\nAssertionError: expected ${index} to be 20`,
          ),
          'src/b.ts(4,2): error TS2322',
          NOISE,
        ].join('\n'),
      ),
    );
    const listing = text.split('Output tail:')[0] ?? '';

    expect(listing.match(/^- src\/a.test.ts::/gm)).toHaveLength(9);
    expect(listing).toContain('- src/b.ts(4,2): error TS2322');
    expect(listing).toContain('and 1 more');
  });

  it('limits the keys and messages to the selected file and keeps all keys without a selection', () => {
    const run = red(
      [
        ' FAIL  src/a.test.ts > adds',
        'AssertionError: expected 1 to be 2',
        ' FAIL  src/b.test.ts > subtracts',
        'AssertionError: expected 3 to be 4',
      ].join('\n'),
    );
    const text = checkFailureText(run, { file: 'src/a.test.ts' });

    expect(text).toContain(
      '1 failure\nFailures:\n- src/a.test.ts::adds\n  AssertionError: expected 1 to be 2',
    );
    expect(text).not.toContain('src/b.test.ts');
    expect(text).not.toContain('expected 3 to be 4');
    expect(text).not.toContain('Output tail:');
    expect(run.output).toContain('src/b.test.ts');
    expect(checkFailureText(run)).toContain('2 failures');
    expect(checkFailureText(run)).toContain(
      '- src/b.test.ts::subtracts\n  AssertionError: expected 3 to be 4',
    );
  });

  it.each(['src/lib.rs', null])('keeps unassigned Rust failures with input file %s', (file) => {
    const run = red('test tests::adds ... FAILED\ntest tests::subtracts ... FAILED');
    const text = checkFailureText(run, { file });

    expect(text).toContain('2 failures\nFailures:\n- tests::adds\n- tests::subtracts');
    expect(text).not.toContain('0 failures');
    if (file === null) expect(text).toContain('Output tail:');
    else expect(text).not.toContain('Output tail:');
  });

  it('keeps unassigned failures alongside only the selected file diagnostics', () => {
    const run = red('test tests::adds ... FAILED\nsrc/a.ts(1,1): error A\nsrc/b.ts(1,1): error B');
    const text = checkFailureText(run, { file: 'src/a.ts' });

    expect(text).toContain('2 failures\nFailures:\n- tests::adds\n- src/a.ts(1,1): error A');
    expect(text).not.toContain('src/b.ts');
    expect(text).not.toContain('error B');
  });

  it('labels new and pre-existing failures within the ten-key listing bound', () => {
    const old = Array.from(
      { length: 10 },
      (_line, index) => `src/old.ts(${index + 1},1): error old`,
    );
    const fresh = 'src/new.ts(1,1): error new';
    const run = { ...red([...old, fresh, NOISE].join('\n')), preExisting: old };
    const text = checkFailureText(run);
    const listing = text.split('Output tail:')[0] ?? '';

    expect(listing).toContain(
      `New failures:\n- ${fresh}\nPre-existing failures (also red at the run base):\n- ${old[0]}`,
    );
    expect(listing.match(/^- /gm)).toHaveLength(10);
    expect(listing).toContain('and 1 more');
    expect(listing).not.toContain(old[9]);
  });

  it('keeps unassigned Go test keys without another file diagnostic message', () => {
    const run = red(
      [
        '--- FAIL: TestA (0.00s)',
        '    a_test.go:12: got 1, want 2',
        '--- FAIL: TestB (0.00s)',
        '    b_test.go:14: got 3, want 4',
      ].join('\n'),
    );
    const text = checkFailureText(run, { file: 'b_test.go' });

    expect(text).toContain('- TestA\n- TestB\n  b_test.go:14: got 3, want 4');
    expect(text).not.toContain('a_test.go');
    expect(text).not.toContain('got 1, want 2');
    expect(checkFailureText(run)).toContain('- TestA\n  a_test.go:12: got 1, want 2');
  });

  it('uses the placeholder reason for a file-scoped incomplete capture', () => {
    const text = checkFailureText(
      {
        checkId: 'V1',
        status: 'fail',
        output: 'src/b.ts(1,1): error B',
        failure: {
          keys: ['output over the capture limit'],
          placeholder: 'output over the capture limit',
        },
      },
      { file: 'src/a.ts' },
    );

    expect(text).toBe('check V1 did not pass (fail): output over the capture limit');
    expect(text).not.toContain('src/b.ts');
  });
});
