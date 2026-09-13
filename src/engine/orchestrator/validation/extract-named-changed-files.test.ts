import { describe, expect, it } from 'vitest';
import { extractNamedChangedFiles } from './extract-named-changed-files.js';

describe('extractNamedChangedFiles', () => {
  it('returns an empty list when nothing in the output matches', () => {
    expect(extractNamedChangedFiles('no paths here', ['src/loop.ts'])).toEqual([]);
  });

  it('matches the path a tsc diagnostic names', () => {
    expect(
      extractNamedChangedFiles('src/loop.ts(12,5): error TS2322: Type mismatch.', [
        'src/loop.ts',
        'src/other.ts',
      ]),
    ).toEqual(['src/loop.ts']);
  });

  it('matches the path a vitest failure names', () => {
    expect(
      extractNamedChangedFiles(' FAIL  src/loop.test.ts > loop\n   ❯ src/loop.ts:12:5', [
        'src/loop.ts',
        'src/other.ts',
      ]),
    ).toEqual(['src/loop.ts']);
  });

  it('matches the path a pytest node id names', () => {
    expect(
      extractNamedChangedFiles('tests/test_loop.py::test_step FAILED', [
        'tests/test_loop.py',
        'src/other.py',
      ]),
    ).toEqual(['tests/test_loop.py']);
  });

  it('matches the path a mypy diagnostic names', () => {
    expect(
      extractNamedChangedFiles(
        'src/loop.py:3: error: Incompatible return value type  [return-value]',
        ['src/loop.py'],
      ),
    ).toEqual(['src/loop.py']);
  });

  it('matches the path a ruff diagnostic names', () => {
    expect(
      extractNamedChangedFiles('src/loop.py:3:1: F401 `os` imported but unused', ['src/loop.py']),
    ).toEqual(['src/loop.py']);
  });

  it('matches a ./-prefixed occurrence from go vet', () => {
    expect(
      extractNamedChangedFiles('./pkg/loop.go:3:2: unreachable code', ['pkg/loop.go']),
    ).toEqual(['pkg/loop.go']);
  });

  it('matches the bare basename a go test frame names', () => {
    expect(
      extractNamedChangedFiles('--- FAIL: TestLoop (0.00s)\n    loop_test.go:12: got 1, want 2', [
        'pkg/loop_test.go',
      ]),
    ).toEqual(['pkg/loop_test.go']);
  });

  it('matches the path a cargo or clippy span arrow names', () => {
    expect(extractNamedChangedFiles('  --> src/lib.rs:3:5', ['src/lib.rs'])).toEqual([
      'src/lib.rs',
    ]);
  });

  it('matches the path a cargo test panic names', () => {
    expect(
      extractNamedChangedFiles("thread 'loop' panicked at src/lib.rs:12:5:", ['src/lib.rs']),
    ).toEqual(['src/lib.rs']);
  });

  it('matches backslash separators in the output and the changed file', () => {
    expect(
      extractNamedChangedFiles('src\\loop.ts(12,5): error TS2322', [
        'src\\loop.ts',
        'src\\other.ts',
      ]),
    ).toEqual(['src\\loop.ts']);
  });

  it('does not match a basename shared with another changed file', () => {
    expect(
      extractNamedChangedFiles('index.ts(12,5): error TS2322', ['src/index.ts', 'lib/index.ts']),
    ).toEqual([]);
  });

  it('does not match a basename glued inside a longer filename', () => {
    expect(
      extractNamedChangedFiles('tests/test_loop.py::test_step FAILED', ['src/loop.py']),
    ).toEqual([]);
  });

  it('does not match a path a longer extension extends', () => {
    expect(extractNamedChangedFiles('src/loop.tsx(12,5): error TS2322', ['src/loop.ts'])).toEqual(
      [],
    );
  });

  it('returns an empty list when the output is empty', () => {
    expect(extractNamedChangedFiles('', ['src/loop.ts'])).toEqual([]);
  });
});
