import { describe, expect, it } from 'vitest';
import { parseFailingTests, readNodeTap } from './test-failures.js';

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

/** `node --test` (Node 22, TAP when stdout is not a terminal) with one red test, as `npm test` prints it. */
const NODE_TAP_SINGLE = [
  '> shop@1.0.0 test',
  '> node --test',
  '',
  'TAP version 13',
  '# Subtest: truncateText keeps short text unchanged',
  'not ok 1 - truncateText keeps short text unchanged',
  '  ---',
  '  duration_ms: 0.581875',
  "  type: 'test'",
  "  location: '/repo/test/legacy.test.mjs:4:1'",
  "  failureType: 'testCodeFailure'",
  '  error: |-',
  '    Expected values to be strictly equal:',
  '    ',
  "    '...' !== 'hello'",
  '    ',
  "  code: 'ERR_ASSERTION'",
  "  name: 'AssertionError'",
  "  expected: 'hello'",
  "  actual: '...'",
  "  operator: 'strictEqual'",
  '  stack: |-',
  '    TestContext.<anonymous> (file:///repo/test/legacy.test.mjs:5:10)',
  '    Test.runInAsyncScope (node:async_hooks:214:14)',
  '    Test.run (node:internal/test_runner/test:1047:25)',
  '  ...',
  '# Subtest: passes',
  'ok 2 - passes',
  '  ---',
  '  duration_ms: 0.055542',
  "  type: 'test'",
  '  ...',
  '1..2',
  '# tests 2',
  '# suites 0',
  '# pass 1',
  '# fail 1',
  '# duration_ms 39.919208',
].join('\n');

/** `node --test` with a red test in a `describe` suite, a nested suite and a red `t.test` subtest. */
const NODE_TAP_NESTED = [
  'TAP version 13',
  '# Subtest: sum',
  '    # Subtest: adds two numbers',
  '    not ok 1 - adds two numbers',
  '      ---',
  '      duration_ms: 0.552541',
  "      type: 'test'",
  "      location: '/repo/test/a.test.mjs:5:3'",
  "      failureType: 'testCodeFailure'",
  '      error: |-',
  '        Expected values to be strictly equal:',
  '        ',
  '        2 !== 3',
  '        ',
  "      code: 'ERR_ASSERTION'",
  '      stack: |-',
  '        TestContext.<anonymous> (file:///repo/test/a.test.mjs:5:41)',
  '        Test.runInAsyncScope (node:async_hooks:214:14)',
  '      ...',
  '    # Subtest: passes',
  '    ok 2 - passes',
  '      ---',
  '      duration_ms: 0.047958',
  "      type: 'test'",
  '      ...',
  '    # Subtest: nested',
  '        # Subtest: fails deep',
  '        not ok 1 - fails deep',
  '          ---',
  '          duration_ms: 0.478959',
  "          type: 'test'",
  "          location: '/repo/test/a.test.mjs:8:5'",
  "          failureType: 'testCodeFailure'",
  "          error: 'deep boom'",
  "          code: 'ERR_TEST_FAILURE'",
  '          stack: |-',
  '            TestContext.<anonymous> (file:///repo/test/a.test.mjs:8:36)',
  '          ...',
  '        1..1',
  '    not ok 3 - nested',
  '      ---',
  '      duration_ms: 0.558125',
  "      type: 'suite'",
  "      location: '/repo/test/a.test.mjs:7:3'",
  "      failureType: 'subtestsFailed'",
  "      error: '1 subtest failed'",
  "      code: 'ERR_TEST_FAILURE'",
  '      ...',
  '    1..3',
  'not ok 1 - sum',
  '  ---',
  '  duration_ms: 1.516833',
  "  type: 'suite'",
  "  location: '/repo/test/a.test.mjs:4:1'",
  "  failureType: 'subtestsFailed'",
  "  error: '2 subtests failed'",
  "  code: 'ERR_TEST_FAILURE'",
  '  ...',
  '# Subtest: outer',
  '    # Subtest: inner fails',
  '    not ok 1 - inner fails',
  '      ---',
  '      duration_ms: 2.110167',
  "      type: 'test'",
  "      location: '/repo/test/a.test.mjs:12:11'",
  "      failureType: 'testCodeFailure'",
  '      error: |-',
  '        The expression evaluated to a falsy value:',
  '        ',
  '          assert.ok(false)',
  '        ',
  "      code: 'ERR_ASSERTION'",
  '      ...',
  '    1..1',
  'not ok 2 - outer',
  '  ---',
  '  duration_ms: 2.486459',
  "  type: 'test'",
  "  location: '/repo/test/a.test.mjs:11:1'",
  "  failureType: 'subtestsFailed'",
  "  error: '1 subtest failed'",
  "  code: 'ERR_TEST_FAILURE'",
  '  ...',
  '1..2',
  '# tests 6',
  '# fail 3',
].join('\n');

/** `node --test` over several files: a file whose process fails, an escaped name, a red todo test. */
const NODE_TAP_FILES = [
  'TAP version 13',
  '# node:internal/modules/esm/resolve:275',
  "# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/repo/test/missing.mjs' imported from /repo/test/x.test.mjs",
  '#     at finalizeResolution (node:internal/modules/esm/resolve:275:11)',
  '# Node.js v22.22.2',
  '# Subtest: test/x.test.mjs',
  'not ok 1 - test/x.test.mjs',
  '  ---',
  '  duration_ms: 36.108125',
  "  type: 'test'",
  "  location: '/repo/test/x.test.mjs:1:1'",
  "  failureType: 'testCodeFailure'",
  '  exitCode: 1',
  '  signal: ~',
  "  error: 'test failed'",
  "  code: 'ERR_TEST_FAILURE'",
  '  ...',
  '# Subtest: a \\# hash name',
  'not ok 2 - a \\# hash name',
  '  ---',
  '  duration_ms: 0.649167',
  "  type: 'test'",
  "  location: '/repo/test/a.test.mjs:15:1'",
  "  failureType: 'testCodeFailure'",
  '  error: |-',
  '    Expected values to be strictly equal:',
  '  ...',
  '# Subtest: todo red',
  'not ok 3 - todo red # TODO',
  '  ---',
  '  duration_ms: 0.098875',
  "  type: 'test'",
  "  location: '/repo/test/a.test.mjs:16:1'",
  "  failureType: 'testCodeFailure'",
  '  error: |-',
  '    Expected values to be strictly equal:',
  '  ...',
  '# Subtest: b fails',
  'not ok 4 - b fails',
  '  ---',
  '  duration_ms: 0.867083',
  "  type: 'test'",
  "  location: '/repo/test/b.test.mjs:3:1'",
  "  failureType: 'testCodeFailure'",
  '  error: |-',
  '    Expected values to be strictly deep-equal:',
  '    + actual - expected',
  '  stack: |-',
  '    TestContext.<anonymous> (file:///repo/test/b.test.mjs:3:32)',
  '  ...',
  '1..4',
  '# fail 4',
  '# todo 1',
].join('\n');

/** `node --test` cancelling tests: under a failed `before` hook, under a timed-out test, an unawaited subtest and a promise that never settles. */
const NODE_TAP_CANCELLED = [
  'TAP version 13',
  '# Subtest: hooked',
  '    # Subtest: inner',
  '        # Subtest: leaf',
  '        not ok 1 - leaf',
  '          ---',
  "          location: '/repo/test/c.test.mjs:4:29'",
  "          failureType: 'cancelledByParent'",
  "          error: 'test did not finish before its parent and was cancelled'",
  '          ...',
  '        1..1',
  '    not ok 1 - inner',
  '      ---',
  "      location: '/repo/test/c.test.mjs:4:3'",
  "      failureType: 'cancelledByParent'",
  "      error: 'test did not finish before its parent and was cancelled'",
  '      ...',
  '    # Subtest: direct',
  '    not ok 2 - direct',
  '      ---',
  "      location: '/repo/test/c.test.mjs:5:3'",
  "      failureType: 'cancelledByParent'",
  "      error: 'test did not finish before its parent and was cancelled'",
  '      ...',
  '    1..2',
  'not ok 1 - hooked',
  '  ---',
  "  location: '/repo/test/c.test.mjs:2:1'",
  "  failureType: 'hookFailed'",
  "  error: 'setup broke'",
  '    SuiteContext.<anonymous> (file:///repo/test/c.test.mjs:3:24)',
  '    TestHook.runInAsyncScope (node:async_hooks:214:14)',
  '    TestHook.run (node:internal/test_runner/test:1047:25)',
  '    TestHook.run (node:internal/test_runner/test:1354:18)',
  '    TestHook.run (node:internal/util:569:20)',
  '    Suite.runHook (node:internal/test_runner/test:965:20)',
  '    Suite.run (node:internal/test_runner/test:1436:18)',
  '  ...',
  '# Subtest: slow parent',
  '    # Subtest: slow child',
  '    not ok 1 - slow child',
  '      ---',
  "      location: '/repo/test/c.test.mjs:7:61'",
  "      failureType: 'cancelledByParent'",
  "      error: 'test did not finish before its parent and was cancelled'",
  '      ...',
  '    1..1',
  'not ok 2 - slow parent',
  '  ---',
  "  location: '/repo/test/c.test.mjs:7:1'",
  "  failureType: 'testTimeoutFailure'",
  "  error: 'test timed out after 20ms'",
  '  ...',
  '# Subtest: parent',
  '    # Subtest: unawaited child',
  '    not ok 1 - unawaited child',
  '      ---',
  "      location: '/repo/test/c.test.mjs:8:27'",
  "      failureType: 'cancelledByParent'",
  "      error: 'test did not finish before its parent and was cancelled'",
  '      ...',
  '    1..1',
  'not ok 3 - parent',
  '  ---',
  "  location: '/repo/test/c.test.mjs:8:1'",
  "  failureType: 'subtestsFailed'",
  "  error: '1 subtest failed'",
  '  ...',
  '# Subtest: suite',
  '    # Subtest: never settles',
  '    not ok 1 - never settles',
  '      ---',
  "      location: '/repo/test/c.test.mjs:9:27'",
  "      failureType: 'cancelledByParent'",
  "      error: 'Promise resolution is still pending but the event loop has already resolved'",
  '      ...',
  '    1..1',
  'not ok 4 - suite',
  '  ---',
  "  location: '/repo/test/c.test.mjs:9:1'",
  "  failureType: 'cancelledByParent'",
  "  error: 'Promise resolution is still pending but the event loop has already resolved'",
  '  ...',
  '1..4',
  '# tests 7',
  '# fail 1',
].join('\n');

/** The output as `failureKeys` reads it: paths relative to the directory the command ran in. */
const fromRepo = (output: string) => output.replaceAll('/repo/', '');

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

  it('reads one red node --test test as one failure named by the test, with its file and message', () => {
    expect(parseFailingTests(fromRepo(NODE_TAP_SINGLE))).toEqual([
      {
        file: 'test/legacy.test.mjs',
        name: 'truncateText keeps short text unchanged',
        message: 'Expected values to be strictly equal:',
      },
    ]);
  });

  it('names a red node --test subtest by its suites and drops the parents it failed', () => {
    expect(parseFailingTests(fromRepo(NODE_TAP_NESTED))).toEqual([
      {
        file: 'test/a.test.mjs',
        name: 'sum > adds two numbers',
        message: 'Expected values to be strictly equal:',
      },
      { file: 'test/a.test.mjs', name: 'sum > nested > fails deep', message: 'deep boom' },
      {
        file: 'test/a.test.mjs',
        name: 'outer > inner fails',
        message: 'The expression evaluated to a falsy value:',
      },
    ]);
  });

  it('counts a node --test failure that cancels tests once, not once per cancelled test', () => {
    expect(parseFailingTests(fromRepo(NODE_TAP_CANCELLED))).toEqual([
      { file: 'test/c.test.mjs', name: 'hooked', message: 'setup broke' },
      { file: 'test/c.test.mjs', name: 'slow parent', message: 'test timed out after 20ms' },
      {
        file: 'test/c.test.mjs',
        name: 'parent > unawaited child',
        message: 'test did not finish before its parent and was cancelled',
      },
      {
        file: 'test/c.test.mjs',
        name: 'suite > never settles',
        message: 'Promise resolution is still pending but the event loop has already resolved',
      },
    ]);
  });

  it('reads each red node --test test, names a failed file process by its file and error line, and skips a red todo test', () => {
    expect(parseFailingTests(fromRepo(NODE_TAP_FILES))).toEqual([
      {
        file: 'test/x.test.mjs',
        name: '',
        message:
          "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'test/missing.mjs' imported from test/x.test.mjs",
      },
      {
        file: 'test/a.test.mjs',
        name: 'a # hash name',
        message: 'Expected values to be strictly equal:',
      },
      {
        file: 'test/b.test.mjs',
        name: 'b fails',
        message: 'Expected values to be strictly deep-equal:',
      },
    ]);
  });

  it('reads a node --test error message quoted in any of the three ways Node quotes it', () => {
    const point = (n: number, error: string) => [
      `# Subtest: t${n}`,
      `not ok ${n} - t${n}`,
      '  ---',
      "  location: '/repo/test/q.test.mjs:2:1'",
      "  failureType: 'testCodeFailure'",
      `  error: ${error}`,
      "  code: 'ERR_TEST_FAILURE'",
      '  ...',
    ];
    const output = [
      'TAP version 13',
      ...point(1, `"can't do it"`),
      ...point(2, `'say "hi"'`),
      ...point(3, '`it\'s "x"`'),
      ...point(4, `'it\\'s \`x\` "y"'`),
      ...point(5, `'a\\\\b'`),
      '1..5',
    ].join('\n');
    expect(parseFailingTests(fromRepo(output)).map((test) => test.message)).toEqual([
      "can't do it",
      'say "hi"',
      `it's "x"`,
      'it\'s `x` "y"',
      'a\\b',
    ]);
  });

  it('keeps every line outside the TAP stream and no test point, YAML block or comment of it', () => {
    const output = `${fromRepo(NODE_TAP_SINGLE)}\nsrc/x.ts(12,5): error TS2322: Type mismatch.`;
    expect(readNodeTap(output).rest).toBe(
      '> shop@1.0.0 test\n> node --test\n\nsrc/x.ts(12,5): error TS2322: Type mismatch.',
    );
  });
});
