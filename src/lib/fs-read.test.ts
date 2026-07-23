import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFileOrEmpty, readValidatedJson, readJsonl, parseJsonlLine } from './fs.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tmp: string;
function makeTmp(): string {
  tmp = createTempDir('fs-read-test');
  return tmp;
}
afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('readFileOrEmpty', () => {
  it('returns content when file exists', async () => {
    const dir = makeTmp();
    const file = join(dir, 'hello.txt');
    writeFileSync(file, 'hello world', 'utf-8');
    expect(await readFileOrEmpty(file)).toBe('hello world');
  });

  it('returns empty string when file does not exist', async () => {
    const dir = makeTmp();
    expect(await readFileOrEmpty(join(dir, 'nope.txt'))).toBe('');
  });

  it('rethrows non-ENOENT read errors', async () => {
    const dir = makeTmp();
    await expect(readFileOrEmpty(dir)).rejects.toThrow();
  });
});

describe('readValidatedJson', () => {
  const parse = (v: unknown): { n: number } | null =>
    typeof v === 'object' && v !== null && 'n' in v && typeof (v as { n: unknown }).n === 'number'
      ? { n: (v as { n: number }).n }
      : null;

  it('returns the fallback and does not warn when the file is missing', () => {
    const dir = makeTmp();
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const result = readValidatedJson(join(dir, 'nope.json'), parse, { n: -1 }, 'label');
    expect(result).toEqual({ n: -1 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('parses and returns valid content', () => {
    const dir = makeTmp();
    const file = join(dir, 'v.json');
    writeFileSync(file, JSON.stringify({ n: 7 }));
    expect(readValidatedJson(file, parse, { n: -1 }, 'label')).toEqual({ n: 7 });
  });

  it('warns once and returns the fallback when JSON is corrupt', () => {
    const dir = makeTmp();
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{ not json');
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(readValidatedJson(file, parse, { n: -1 }, 'corrupt-label')).toEqual({ n: -1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('corrupt-label');
    warn.mockRestore();
  });

  it('warns and returns the fallback when the parser rejects the value', () => {
    const dir = makeTmp();
    const file = join(dir, 'wrong.json');
    writeFileSync(file, JSON.stringify({ other: true }));
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(readValidatedJson(file, parse, { n: -1 }, 'schema-label')).toEqual({ n: -1 });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('readJsonl', () => {
  const parseLine = (v: unknown): number | null => (typeof v === 'number' ? v : null);

  it('returns [] without warning when the file is missing', () => {
    const dir = makeTmp();
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(readJsonl(join(dir, 'nope.jsonl'), parseLine, 'label')).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips blank lines and collects parsed values', () => {
    const dir = makeTmp();
    const file = join(dir, 'lines.jsonl');
    writeFileSync(file, '1\n\n2\n3\n');
    expect(readJsonl(file, parseLine, 'label')).toEqual([1, 2, 3]);
  });

  it('warns and skips a single malformed line without aborting the rest', () => {
    const dir = makeTmp();
    const file = join(dir, 'partial.jsonl');
    writeFileSync(file, '1\n{bad\n3\n');
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(readJsonl(file, parseLine, 'jsonl-label')).toEqual([1, 3]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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
