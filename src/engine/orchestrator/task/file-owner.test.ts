import { describe, expect, it } from 'vitest';
import { failingFilesFromOutput } from './file-owner.js';

const WORKSPACE = '/ws';

function filesOf(output: string): string[] {
  return failingFilesFromOutput(output, WORKSPACE);
}

describe('failingFilesFromOutput', () => {
  it('names no file from an npm script banner', () => {
    expect(filesOf('> pkg@1.0.0 test\n> tsx scripts/x.ts')).toEqual([]);
    expect(
      filesOf(
        '\n> splitbrief@0.1.0 check:invariants\n> tsx scripts/check-invariants.ts\n\nInvariant 3 failed',
      ),
    ).toEqual([]);
  });

  it('names no file from command text or a runner summary', () => {
    expect(
      filesOf('Error: Command failed: tsx scripts/x.ts\nmake: *** [Makefile:2: check] Error 1'),
    ).toEqual([]);
    expect(filesOf('npm error Lifecycle script `test` failed\nDuration  6.93s')).toEqual([]);
  });

  it('names the file of a tsc diagnostic', () => {
    expect(filesOf('src/a.ts(12,3): error TS2322: Type mismatch.')).toEqual(['src/a.ts']);
    expect(filesOf('src/a.ts:12:3 - error TS2322: Type mismatch.')).toEqual(['src/a.ts']);
  });

  it('names the stack frame file of a vitest failure, not its banner', () => {
    expect(
      filesOf('> pkg@1.0.0 test\n> vitest run\n FAIL  src/x.test.ts > x\n   ❯ src/x.ts:12:5'),
    ).toEqual(['src/x.ts']);
  });

  it('names the stack frame file of a jest failure', () => {
    expect(
      filesOf(' FAIL  src/x.test.ts\n  ● x › y\n      at Object.<anonymous> (src/x.test.ts:12:5)'),
    ).toEqual(['src/x.test.ts']);
  });

  it('names the file of a biome diagnostic', () => {
    expect(filesOf('src/a.ts:3:7 lint/style/useConst FIXABLE ━━━━━━━━━━')).toEqual(['src/a.ts']);
  });

  it('names the files of a pytest failure', () => {
    expect(
      filesOf('tests/test_x.py:12: AssertionError\nFAILED tests/test_x.py::test_y - assert 1 == 2'),
    ).toEqual(['tests/test_x.py']);
  });

  it('names the file of a go test failure, not its package line', () => {
    expect(
      filesOf(
        '--- FAIL: TestX (0.00s)\n    x_test.go:12: got 1, want 2\nFAIL\texample.com/pkg\t0.01s',
      ),
    ).toEqual(['x_test.go']);
    expect(filesOf('FAIL\texample.com/pkg\t0.01s')).toEqual([]);
  });

  it('names the file of a cargo diagnostic', () => {
    expect(filesOf('error[E0308]: mismatched types\n  --> src/lib.rs:3:5')).toEqual(['src/lib.rs']);
  });

  it('names each file of an output that lists one whole path per line', () => {
    expect(filesOf('src/a.ts\n./src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('names no file from a line that only starts like a pytest node id', () => {
    expect(filesOf('a.py:: weird')).toEqual([]);
  });

  it('names an absolute path relative to the workspace and drops one outside it', () => {
    expect(filesOf('/ws/src/a.ts:3:1: error\n/elsewhere/x.ts:1: error')).toEqual(['src/a.ts']);
  });
});
