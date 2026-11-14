import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readValidatedJsonResult, parseJsonlLine } from './read.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tmp: string;
function makeTmp(): string {
  tmp = createTempDir('fs-read-test');
  return tmp;
}
afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('readValidatedJsonResult', () => {
  const parse = (v: unknown): { n: number } | null =>
    typeof v === 'object' && v !== null && 'n' in v && typeof (v as { n: unknown }).n === 'number'
      ? { n: (v as { n: number }).n }
      : null;

  it('tells a missing file from a file that is not JSON and from a value of the wrong shape', () => {
    const dir = makeTmp();
    const corrupt = join(dir, 'bad.json');
    writeFileSync(corrupt, '{ not json');
    const wrongShape = join(dir, 'wrong.json');
    writeFileSync(wrongShape, JSON.stringify({ other: true }));

    expect(readValidatedJsonResult(join(dir, 'nope.json'), parse)).toEqual({ kind: 'missing' });
    expect(readValidatedJsonResult(corrupt, parse)).toEqual({
      kind: 'unreadable',
      cause: expect.any(SyntaxError),
    });
    expect(readValidatedJsonResult(wrongShape, parse)).toEqual({
      kind: 'unreadable',
      cause: undefined,
    });
  });
});

describe('parseJsonlLine', () => {
  it('classifies a blank or whitespace-only line as blank', () => {
    expect(parseJsonlLine('')).toEqual({ kind: 'blank' });
    expect(parseJsonlLine('   \t ')).toEqual({ kind: 'blank' });
  });

  it('parses a valid JSON line and exposes the value', () => {
    expect(parseJsonlLine('{"a":1}')).toEqual({ kind: 'value', value: { a: 1 } });
    expect(parseJsonlLine('42')).toEqual({ kind: 'value', value: 42 });
  });

  it('preserves a literal null line as a parsed value, not blank or corrupt', () => {
    expect(parseJsonlLine('null')).toEqual({ kind: 'value', value: null });
  });

  it('classifies an unparseable line as corrupt and carries the cause', () => {
    const result = parseJsonlLine('{bad');
    expect(result.kind).toBe('corrupt');
    if (result.kind === 'corrupt') expect(result.cause).toBeInstanceOf(SyntaxError);
  });
});
