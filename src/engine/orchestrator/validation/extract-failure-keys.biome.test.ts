import { describe, expect, it } from 'vitest';
import { failureKeys } from './extract-failure-keys.js';

describe('failureKeys — Biome', () => {
  it('drops the trailing heavy-dash rule from Biome lint, format and deserialize lines', () => {
    const stdout = [
      'src/a.ts:3:7 lint/suspicious/noExplicitAny  FIXABLE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      'src/a.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      'biome.json:39:13 deserialize  DEPRECATED  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
    const run = {
      capture: { stdout, stderr: '', complete: true },
      exitCode: 1,
    };
    const first = failureKeys(run, '/repo');
    const second = failureKeys(run, '/repo');

    expect(first.keys.length).toBeGreaterThan(0);
    expect(first.keys).toEqual([
      'src/a.ts:3:7 lint/suspicious/noExplicitAny  FIXABLE',
      'biome.json:39:13 deserialize  DEPRECATED',
    ]);
    for (const key of first.keys) {
      expect(key).not.toContain('━');
    }
    expect(second.keys).toEqual(first.keys);
  });

  it('drops a Biome diagnostic whose message is a note or a warning', () => {
    const stdout = [
      ' FAIL  src/a.test.ts > adds two numbers',
      'AssertionError: expected 1 to be 2',
      ' FAIL  src/b.test.ts > subtracts',
      'AssertionError: expected 3 to be 1',
      ' FAIL  src/c.test.ts > multiplies',
      'AssertionError: expected 4 to be 12',
      '',
      'src/a.ts:3:7 lint/style/useIndexOf  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '  i Prefer Array#indexOf() over Array#findIndex() when looking for an index.',
      '',
      'src/b.ts:5:9 lint/style/useIndexOf  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '  ℹ Prefer Array#indexOf() over Array#findIndex() when looking for an index.',
      '',
      'src/c.ts:7:2 lint/style/useIndexOf  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '  ⚠ Prefer Array#indexOf() over Array#findIndex() when looking for an index.',
      '',
      'biome.json:39:13 deserialize  DEPRECATED  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      "  i The 'include' field is deprecated. Use 'includes' instead.",
      '',
      'src/d.ts:1:1 lint/style/useConst  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '  ! This variable is never reassigned.',
    ].join('\n');
    const run = { capture: { stdout, stderr: '', complete: true }, exitCode: 1 };

    expect(failureKeys(run, '/repo').keys).toEqual([
      'src/a.test.ts::adds two numbers',
      'src/b.test.ts::subtracts',
      'src/c.test.ts::multiplies',
    ]);
  });

  it('keeps a Biome diagnostic whose message is an error', () => {
    const stdout = [
      'src/a.ts:3:7 lint/suspicious/noExplicitAny  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '  × Unexpected any. Specify a different type.',
      '',
      'src/b.ts:9:4 lint/complexity/noBannedTypes  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      "  ✖ Don't use '{}' as a type.",
    ].join('\n');
    const run = { capture: { stdout, stderr: '', complete: true }, exitCode: 1 };

    expect(failureKeys(run, '/repo').keys).toEqual([
      'src/a.ts:3:7 lint/suspicious/noExplicitAny',
      'src/b.ts:9:4 lint/complexity/noBannedTypes  FIXABLE',
    ]);
  });
});
