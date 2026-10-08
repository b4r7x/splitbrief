import { describe, expect, it } from 'vitest';
import { extractFailureKeys } from './extract-failure-keys.js';

describe('extractFailureKeys', () => {
  it('keys a tsc diagnostic by path, line and column', () => {
    expect(extractFailureKeys('src/x.ts(12,5): error TS2322: Type mismatch.')).toEqual([
      'src/x.ts(12,5)',
    ]);
  });

  it('keys a vitest failure by its stack frame, not its pathless header', () => {
    expect(extractFailureKeys(' FAIL  src/x.test.ts > x\n   ❯ src/x.ts:12:5')).toEqual([
      'src/x.ts:12',
    ]);
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
    expect(extractFailureKeys(tail('02:34:50', '6.93s'))).toEqual(['src/legacy.test.ts:12']);
    expect(extractFailureKeys(tail('02:41:07', '7.11s'))).toEqual(['src/legacy.test.ts:12']);
  });

  it('keys by line text when the whole output names no path', () => {
    expect(extractFailureKeys('error: linker `cc` failed\nDuration  6.93s')).toEqual([
      'error: linker `cc` failed',
      'Duration  6.93s',
    ]);
  });

  it('keys a pytest failure by its node id', () => {
    expect(extractFailureKeys('tests/test_x.py::test_y FAILED')).toEqual([
      'tests/test_x.py::test_y',
    ]);
  });

  it('keys a mypy diagnostic by path and line', () => {
    expect(
      extractFailureKeys('src/x.py:3: error: Incompatible return value type  [return-value]'),
    ).toEqual(['src/x.py:3']);
  });

  it('keys a ruff diagnostic by path and line', () => {
    expect(extractFailureKeys('src/x.py:3:1: F401 `os` imported but unused')).toEqual([
      'src/x.py:3',
    ]);
  });

  it('keys a go vet diagnostic without its leading ./', () => {
    expect(extractFailureKeys('./pkg/x.go:3:2: unreachable code')).toEqual(['pkg/x.go:3']);
  });

  it('keys a go test failure by its bare basename frame, not its name line', () => {
    expect(extractFailureKeys('--- FAIL: TestX (0.00s)\n    x_test.go:12: got 1, want 2')).toEqual([
      'x_test.go:12',
    ]);
  });

  it('keys a cargo or clippy span arrow by path and line', () => {
    expect(extractFailureKeys('  --> src/lib.rs:3:5')).toEqual(['src/lib.rs:3']);
  });

  it('keys a cargo test panic by the panicking source line', () => {
    expect(extractFailureKeys("thread 'x' panicked at src/lib.rs:12:5:\nassertion failed")).toEqual(
      ['src/lib.rs:12'],
    );
  });

  it('drops blank lines and repeats', () => {
    expect(extractFailureKeys('src/x.py:3: error: a\n\nsrc/x.py:3: error: b\n')).toEqual([
      'src/x.py:3',
    ]);
  });

  it('normalizes backslash separators', () => {
    expect(extractFailureKeys('src\\x.ts(12,5): error TS2322')).toEqual(['src/x.ts(12,5)']);
  });
});
