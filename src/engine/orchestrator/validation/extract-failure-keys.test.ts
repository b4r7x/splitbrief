import { describe, expect, it } from 'vitest';
import { extractFailureKeys, failureKeys } from './extract-failure-keys.js';

function keysOf(output: string): string[] {
  const extracted = extractFailureKeys(output);
  expect(extracted.diagnostics).toBe(true);
  return extracted.keys;
}

describe('extractFailureKeys', () => {
  it('keys a tsc diagnostic by path, line and column', () => {
    expect(keysOf('src/x.ts(12,5): error TS2322: Type mismatch.')).toEqual([
      'src/x.ts(12,5): error TS2322: Type mismatch.',
    ]);
  });

  it('keys a vitest failure by its test name and drops its stack frame', () => {
    expect(
      failureKeys(
        { capture: { text: ' FAIL  src/x.test.ts > x\n   ❯ src/x.ts:12:5', complete: true } },
        '/repo',
      ).keys,
    ).toEqual(['src/x.test.ts::x']);
  });

  it('drops a test runner summary and its timings when the tail names a path', () => {
    const tail = (startAt: string, duration: string) =>
      [
        ' FAIL  src/legacy.test.ts > legacy > still red',
        'AssertionError: expected 1 to be 2',
        ' ❯ src/legacy.test.ts:12:20',
        '',
        ' Test Files  1 failed | 41 passed (42)',
        `   Start at  ${startAt}`,
        `   Duration  ${duration}`,
      ].join('\n');
    for (const text of [tail('02:34:50', '6.93s'), tail('02:41:07', '7.11s')]) {
      expect(failureKeys({ capture: { text, complete: true } }, '/repo').keys).toEqual([
        'src/legacy.test.ts::legacy > still red',
      ]);
    }
  });

  it('keys by line text, and says it found no diagnostic, when the whole output names no path', () => {
    expect(extractFailureKeys('error: linker `cc` failed\nDuration  6.93s')).toEqual({
      keys: ['error: linker `cc` failed', 'Duration  6.93s'],
      diagnostics: false,
    });
  });

  it('finds no diagnostic in an npm script banner or a make error summary', () => {
    expect(extractFailureKeys('> x@1.0.0 test\n> node -e "process.exit(1)"')).toEqual({
      keys: ['> x@1.0.0 test', '> node -e "process.exit(1)"'],
      diagnostics: false,
    });
    expect(extractFailureKeys('make: *** [Makefile:2: check] Error 1')).toEqual({
      keys: ['make: *** [Makefile:2: check] Error 1'],
      diagnostics: false,
    });
  });

  it('finds no key and no diagnostic in empty output', () => {
    expect(extractFailureKeys('\n  \n')).toEqual({ keys: [], diagnostics: false });
  });

  it('keys a pytest failure by its node id', () => {
    expect(keysOf('tests/test_x.py::test_y FAILED')).toEqual(['tests/test_x.py::test_y']);
  });

  it.each([
    'tests/test_smoke.py::test_ok PASSED [ 50%]',
    'tests/test_smoke.py::test_ok SKIPPED [ 50%]',
    'tests/test_smoke.py::test_ok XFAIL [ 50%]',
    'tests/test_smoke.py::test_ok XPASS [ 50%]',
    '✓ src/x.test.ts:3: passes',
    '√ src/x.test.ts:3: passes',
    'tests/a.py::test_x',
    'src/a.py:3: DeprecationWarning: deprecated',
    'src/a.c:3:1: warning: unused variable',
    'src/a.c:3:1: WARNING: unused variable',
  ])('ignores non-failure row %s', (line) => {
    expect(extractFailureKeys(line).diagnostics).toBe(false);
    const diagnostic = 'src/x.ts(12,5): error TS2322: Type mismatch.';
    expect(keysOf(`${line}\n${diagnostic}`)).toEqual([diagnostic]);
  });

  it('keys only the failing node ids of a verbose pytest run', () => {
    const output = [
      'tests/test_smoke.py::test_ok PASSED [ 33%]',
      'tests/test_smoke.py::test_skip SKIPPED [ 66%]',
      'tests/test_late.py::test_late FAILED [100%]',
      'FAILED tests/test_late.py::test_late - assert 1 == 2',
    ].join('\n');
    expect(failureKeys({ capture: { text: output, complete: true } }, '/repo').keys).toEqual([
      'tests/test_late.py::test_late',
    ]);
  });

  it.each([
    "src/a.ts(1,1): error TS2304: Cannot find name 'warning'.",
    "src/a.ts(1,1): error TS2304: Cannot find name 'DeprecationWarning'.",
    "src/a.ts(1,1): error TS2304: Cannot find name 'PASSED'.",
    "src/a.ts(1,1): error TS2339: Property 'x' does not exist on type 'A::B'.",
  ])('keeps an error whose message names a non-failure word: %s', (line) => {
    expect(keysOf(line)).toEqual([line]);
  });

  it('keys a pytest collection error by its node id', () => {
    expect(keysOf('ERROR tests/a.py::test_x')).toEqual(['tests/a.py::test_x']);
  });

  it('keys a mypy diagnostic by path and line', () => {
    expect(keysOf('src/x.py:3: error: Incompatible return value type  [return-value]')).toEqual([
      'src/x.py:3: error: Incompatible return value type  [return-value]',
    ]);
  });

  it('keys a ruff diagnostic by path and line', () => {
    expect(keysOf('src/x.py:3:1: F401 `os` imported but unused')).toEqual([
      'src/x.py:3:1: F401 `os` imported but unused',
    ]);
  });

  it('keys a go vet diagnostic without its leading ./', () => {
    expect(keysOf('./pkg/x.go:3:2: unreachable code')).toEqual(['pkg/x.go:3:2: unreachable code']);
  });

  it('keys a go test failure by its bare basename frame, not its name line', () => {
    expect(keysOf('--- FAIL: TestX (0.00s)\n    x_test.go:12: got 1, want 2')).toEqual([
      'x_test.go:12: got 1, want 2',
    ]);
  });

  it('keys a cargo or clippy span arrow by path and line', () => {
    expect(keysOf('  --> src/lib.rs:3:5')).toEqual(['src/lib.rs:3:5']);
  });

  it('keys a cargo test panic by the panicking source line', () => {
    expect(keysOf("thread 'x' panicked at src/lib.rs:12:5:\nassertion failed")).toEqual([
      'src/lib.rs:12:5:',
    ]);
  });

  it('drops blank lines and repeats', () => {
    expect(keysOf('src/x.py:3: error: a\n\nsrc/x.py:3: error: b\nsrc/x.py:3: error: a\n')).toEqual([
      'src/x.py:3: error: a',
      'src/x.py:3: error: b',
    ]);
  });

  it('normalizes backslash separators', () => {
    expect(keysOf('src\\x.ts(12,5): error TS2322')).toEqual(['src/x.ts(12,5): error TS2322']);
  });

  it('finds no diagnostic in a version or a duration', () => {
    expect(extractFailureKeys('node 22.1.0:1\n1.5:3').diagnostics).toBe(false);
  });
});

describe('failureKeys', () => {
  it('collects compiler diagnostics and failed tests from the same output', () => {
    const diagnostic =
      "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.";
    const output = `${diagnostic}\n FAIL  src/b.test.ts > fails\n ❯ src/b.test.ts:4:2`;
    expect(
      failureKeys({ capture: { text: output, complete: true }, exitCode: 1 }, '/repo'),
    ).toEqual({
      keys: ['src/b.test.ts::fails', diagnostic],
    });
  });

  it('excludes stack frames but keeps compiler diagnostics in test files', () => {
    const diagnostic = 'src/b.test.ts(3,3): error TS2304: Cannot find name x.';
    const output = [
      '  at fails (src/a.ts:1:2)',
      '❯ src/b.test.ts:4:2',
      '→ src/c.test.ts:5:2',
      'tests/test_a.py:7: in test_fails',
      'C:\\repo\\tests\\test_a.py:7: in test_fails',
      diagnostic,
    ].join('\n');
    expect(failureKeys({ capture: { text: output, complete: true } }, '/repo')).toEqual({
      keys: [diagnostic],
    });
  });

  it('returns one placeholder when the process capture is incomplete', () => {
    expect(
      failureKeys({ capture: { text: 'src/a.ts(1,1): error TS2322', complete: false } }, '/repo'),
    ).toEqual({
      keys: ['output over the capture limit'],
      placeholder: 'output over the capture limit',
    });
  });

  it('keys an output that lists only whole paths by those paths', () => {
    expect(
      failureKeys(
        { capture: { text: 'src/a.ts\n./src/b.ts\nsrc/a.ts', complete: true }, exitCode: 1 },
        '/repo',
      ),
    ).toEqual({ keys: ['src/a.ts', 'src/b.ts'] });
  });

  it('keeps the placeholder when a path list holds any other line', () => {
    expect(
      failureKeys(
        {
          capture: { text: 'src/a.ts\nsrc/b.ts\nfatal: runner crashed', complete: true },
          exitCode: 1,
        },
        '/repo',
      ),
    ).toEqual({
      keys: ['exited with code 1'],
      placeholder: 'exited with code 1 without diagnostics',
    });
  });
});
