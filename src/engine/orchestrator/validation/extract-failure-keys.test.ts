import { describe, expect, it } from 'vitest';
import { extractFailureKeys, fileFromFailureKey } from './extract-failure-keys.js';

function keysOf(output: string): string[] {
  const extracted = extractFailureKeys(output);
  expect(extracted.diagnostics).toBe(true);
  return extracted.keys;
}

describe('extractFailureKeys', () => {
  it('keys a tsc diagnostic by path, line and column', () => {
    expect(keysOf('src/x.ts(12,5): error TS2322: Type mismatch.')).toEqual(['src/x.ts(12,5)']);
  });

  it('keys a vitest failure by its stack frame, not its pathless header', () => {
    expect(keysOf(' FAIL  src/x.test.ts > x\n   ❯ src/x.ts:12:5')).toEqual(['src/x.ts:12']);
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
    expect(keysOf(tail('02:34:50', '6.93s'))).toEqual(['src/legacy.test.ts:12']);
    expect(keysOf(tail('02:41:07', '7.11s'))).toEqual(['src/legacy.test.ts:12']);
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

  it('keys a mypy diagnostic by path and line', () => {
    expect(keysOf('src/x.py:3: error: Incompatible return value type  [return-value]')).toEqual([
      'src/x.py:3',
    ]);
  });

  it('keys a ruff diagnostic by path and line', () => {
    expect(keysOf('src/x.py:3:1: F401 `os` imported but unused')).toEqual(['src/x.py:3']);
  });

  it('keys a go vet diagnostic without its leading ./', () => {
    expect(keysOf('./pkg/x.go:3:2: unreachable code')).toEqual(['pkg/x.go:3']);
  });

  it('keys a go test failure by its bare basename frame, not its name line', () => {
    expect(keysOf('--- FAIL: TestX (0.00s)\n    x_test.go:12: got 1, want 2')).toEqual([
      'x_test.go:12',
    ]);
  });

  it('keys a cargo or clippy span arrow by path and line', () => {
    expect(keysOf('  --> src/lib.rs:3:5')).toEqual(['src/lib.rs:3']);
  });

  it('keys a cargo test panic by the panicking source line', () => {
    expect(keysOf("thread 'x' panicked at src/lib.rs:12:5:\nassertion failed")).toEqual([
      'src/lib.rs:12',
    ]);
  });

  it('drops blank lines and repeats', () => {
    expect(keysOf('src/x.py:3: error: a\n\nsrc/x.py:3: error: b\n')).toEqual(['src/x.py:3']);
  });

  it('normalizes backslash separators', () => {
    expect(keysOf('src\\x.ts(12,5): error TS2322')).toEqual(['src/x.ts(12,5)']);
  });

  it('finds no diagnostic in a version or a duration', () => {
    expect(extractFailureKeys('node 22.1.0:1\n1.5:3').diagnostics).toBe(false);
  });
});

describe('fileFromFailureKey', () => {
  it('reads the file of each diagnostic key shape', () => {
    expect(fileFromFailureKey('src/a.ts(12,3)')).toBe('src/a.ts');
    expect(fileFromFailureKey('src/a.ts:12')).toBe('src/a.ts');
    expect(fileFromFailureKey('tests/test_x.py::test_y[a')).toBe('tests/test_x.py');
    expect(fileFromFailureKey('x_test.go:12')).toBe('x_test.go');
  });

  it('reads an output line that is one whole path', () => {
    expect(fileFromFailureKey('src/a.ts')).toBe('src/a.ts');
    expect(fileFromFailureKey('./src/a.ts')).toBe('src/a.ts');
  });

  it('reads no file from an npm script banner', () => {
    expect(fileFromFailureKey('> pkg@1.0.0 test')).toBeNull();
    expect(fileFromFailureKey('> tsx scripts/x.ts')).toBeNull();
    expect(fileFromFailureKey('> tsx scripts/check-invariants.ts')).toBeNull();
  });

  it('reads no file from command text, a runner summary or a version', () => {
    expect(fileFromFailureKey('Error: Command failed: tsx scripts/x.ts')).toBeNull();
    expect(fileFromFailureKey('make: *** [Makefile:2: check] Error 1')).toBeNull();
    expect(fileFromFailureKey('Duration  6.93s')).toBeNull();
    expect(fileFromFailureKey('1.0.0')).toBeNull();
    expect(fileFromFailureKey('src/a.ts:')).toBeNull();
  });
});
