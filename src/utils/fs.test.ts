import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFileOrEmpty } from './fs.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tmp: string;

function makeTmp(): string {
  tmp = createTempDir('fs-test');
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
});
