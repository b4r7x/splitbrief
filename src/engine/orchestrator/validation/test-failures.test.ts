import { describe, expect, it } from 'vitest';
import { parseFailingTests } from './test-failures.js';

const ESC = '\u001b';
const red = (text: string) => `${ESC}[31m${text}${ESC}[39m`;

/** A vitest 4 red run as `npm test` prints it: stdout summary, stderr failure block, then teardown noise of passing tests. */
const VITEST_STDOUT = [
  ' ❯ testing/visual/workflow-fixtures.test.tsx (3 tests | 1 failed) 812ms',
  '   × workflow visual fixtures > renders every checkpoint through the production App',
  '',
  ' Test Files  2 failed | 1212 passed | 6 skipped (1226)',
  '      Tests  3 failed | 15963 passed | 18 skipped (15993)',
  '   Start at  10:08:48',
  '   Duration  3350.12s',
].join('\n');

const VITEST_STDERR = [
  '⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ` ${red('FAIL')}  |default| testing/visual/workflow-fixtures.test.tsx > workflow visual fixtures > renders every checkpoint through the production App`,
  'Error: No workflow checkpoint predicate for scenario workflow-seat-switched and checkpoint seat-switched',
  ' ❯ checkpointPredicate testing/visual/gallery/checkpoints.ts:43:13',
  '     41|     const predicate = workflowCheckpointPredicates.get(checkpoint.id);',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯',
  '',
  ' FAIL  |default| src/engine/events/replay.test.ts > readRunEvents > covers every event variant the schema declares',
  ' FAIL  |default| src/engine/events/replay.test.ts > readRunEvents > round-trips every event variant through session.jsonl',
  "AssertionError: expected [ 'seat_switched' ] to deeply equal []",
  '',
  '- Expected',
  '+ Received',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯',
  '',
  `${ESC}[2mIsolation cleanup failed for session sess-3: ENOENT: no such file or directory, rm '/var/folders/k8/T/task-step-test-WMQyd9/state.json'${ESC}[0m`,
  `${ESC}[2mheartbeat write failed; liveness pings paused: EACCES: permission denied, open '/var/folders/k8/T/lock-x/heartbeat'${ESC}[0m`,
  'implementer-temperature: dropped (cli backend claude-code does not take a temperature)',
  'orphan sessions: skipping /var/folders/k8/T/orphans-Q2/sessions/x: EACCES',
].join('\n');

describe('parseFailingTests', () => {
  it('ignores a TUI frame inside a vitest error block', () => {
    expect(
      parseFailingTests(
        ' FAIL  |default| src/x.test.ts > s > t\nError: render failed\nLast frame:\n ● Plan → ● Build → ○ Review\n0/3 briefs passed',
      ),
    ).toEqual([{ file: 'src/x.test.ts', name: 's > t', message: 'Error: render failed' }]);
  });

  it.each(['stdout', 'stderr'])('ignores a TUI frame in %s from a passing test', (stream) => {
    expect(
      parseFailingTests(
        ` FAIL  |default| src/x.test.ts > s > t\nAssertionError: boom\n\n${stream} | src/y.test.ts > renders\n ● Plan → ● Build 0:41`,
      ),
    ).toEqual([{ file: 'src/x.test.ts', name: 's > t', message: 'AssertionError: boom' }]);
  });

  it('reads the coloured vitest project badge and the plain header', () => {
    expect(
      parseFailingTests(
        ` FAIL  ${ESC}[30m${ESC}[42m default ${ESC}[49m${ESC}[39m src/x.test.ts > s > t\nError: badge\n FAIL  src/y.test.ts > plain\nError: plain`,
      ),
    ).toEqual([
      { file: 'src/x.test.ts', name: 's > t', message: 'Error: badge' },
      { file: 'src/y.test.ts', name: 'plain', message: 'Error: plain' },
    ]);
  });

  it.each(['6.312 s', '12 s', '150 ms'])('reads a timed jest file header (%s)', (duration) => {
    expect(
      parseFailingTests(
        ` FAIL  src/slow.test.js (${duration})\n\n  ● slow › completes\n\n    Error: slow`,
      ),
    ).toEqual([{ file: 'src/slow.test.js', name: 'slow > completes', message: 'Error: slow' }]);
  });

  it('reads multiple jest failures with blank lines between their blocks', () => {
    expect(
      parseFailingTests(
        ' FAIL  src/sum.test.js (6.312 s)\n\n  ● sum › first\n\n    Error: first\n\n  ● sum › second\n\n    Error: second',
      ),
    ).toEqual([
      { file: 'src/sum.test.js', name: 'sum > first', message: 'Error: first' },
      { file: 'src/sum.test.js', name: 'sum > second', message: 'Error: second' },
    ]);
  });

  it.each([
    '\nTests: 1 failed\n',
    'stdout | src/y.test.ts > renders\n',
    'stderr | src/y.test.ts > renders\n',
    'FAIL |unknown| extra\n',
    'FAIL src/v.test.ts > real\nError: real\n',
  ])('ends the jest file section at %j', (boundary) => {
    const failures = parseFailingTests(
      `FAIL src/j.test.js\n  ● jest\n    Error: jest\n${boundary} ● Plan → ● Build`,
    );
    expect(failures.map(({ name }) => name)).toEqual(
      boundary.startsWith('FAIL src/v') ? ['jest', 'real'] : ['jest'],
    );
  });

  it('reads each failing vitest test as file, name and assertion message, and nothing from the noise of passing tests', () => {
    expect(parseFailingTests(`${VITEST_STDOUT}\n${VITEST_STDERR}`)).toEqual([
      {
        file: 'testing/visual/workflow-fixtures.test.tsx',
        name: 'workflow visual fixtures > renders every checkpoint through the production App',
        message:
          'Error: No workflow checkpoint predicate for scenario workflow-seat-switched and checkpoint seat-switched',
      },
      {
        file: 'src/engine/events/replay.test.ts',
        name: 'readRunEvents > covers every event variant the schema declares',
        message: "AssertionError: expected [ 'seat_switched' ] to deeply equal []",
      },
      {
        file: 'src/engine/events/replay.test.ts',
        name: 'readRunEvents > round-trips every event variant through session.jsonl',
        message: "AssertionError: expected [ 'seat_switched' ] to deeply equal []",
      },
    ]);
  });

  it('finds no failing test in output that is only the noise of passing tests', () => {
    const noise = VITEST_STDERR.split('\n').slice(-4).join('\n');
    expect(parseFailingTests(noise)).toEqual([]);
  });

  it('reads a vitest failed suite as its file with no test name', () => {
    const output = [
      '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯',
      '',
      ' FAIL  |default| src/broken.test.ts [ src/broken.test.ts ]',
      "Error: Cannot find module './missing.js'",
    ].join('\n');
    expect(parseFailingTests(output)).toEqual([
      { file: 'src/broken.test.ts', name: '', message: "Error: Cannot find module './missing.js'" },
    ]);
  });

  it('reads a jest failure under its file header with the name joined like vitest', () => {
    const output = [
      ` ${ESC}[1m${ESC}[7m${red(' FAIL ')}${ESC}[27m${ESC}[22m src/sum.test.js`,
      '  ● sum › adds two numbers',
      '',
      '    expect(received).toBe(expected) // Object.is equality',
      '',
      'Tests:       1 failed, 4 passed, 5 total',
    ].join('\n');
    expect(parseFailingTests(output)).toEqual([
      {
        file: 'src/sum.test.js',
        name: 'sum > adds two numbers',
        message: 'expect(received).toBe(expected) // Object.is equality',
      },
    ]);
  });

  it('reads a pytest short summary line', () => {
    expect(
      parseFailingTests(
        'FAILED tests/test_totals.py::test_adds_tax - AssertionError: assert 3 == 4\n1 failed, 9 passed in 0.12s',
      ),
    ).toEqual([
      {
        file: 'tests/test_totals.py',
        name: 'test_adds_tax',
        message: 'AssertionError: assert 3 == 4',
      },
    ]);
  });

  it('reads a go test failure by its test name and first log line', () => {
    expect(
      parseFailingTests(
        '--- FAIL: TestTotals (0.00s)\n    totals_test.go:12: got 3, want 4\nFAIL\nFAIL\texample.com/shop/totals\t0.004s',
      ),
    ).toEqual([{ file: '', name: 'TestTotals', message: 'totals_test.go:12: got 3, want 4' }]);
  });

  it('reads a cargo test failure by its test path', () => {
    expect(
      parseFailingTests(
        'test totals::adds_tax ... FAILED\n\nfailures:\n\ntest result: FAILED. 0 passed; 1 failed',
      ),
    ).toEqual([{ file: '', name: 'totals::adds_tax', message: '' }]);
  });
  it('keeps repeated file and test names once in first-seen order', () => {
    expect(
      parseFailingTests(
        ' FAIL  src/a.test.ts > a > first\nError: one\n FAIL  src/b.test.ts > second\nError: two\n FAIL  src/a.test.ts > a > first\nError: repeated',
      ),
    ).toEqual([
      { file: 'src/a.test.ts', name: 'a > first', message: 'Error: one' },
      { file: 'src/b.test.ts', name: 'second', message: 'Error: two' },
    ]);
  });
});
