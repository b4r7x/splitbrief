import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFileOrEmpty } from '../utils/fs.js';
import {
  ensureTinySpecDir,
  writeSpecFile,
  readSpecFile,
  validateTaskPath,
} from './paths-io.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { TINY_SPEC_DIR } from './paths.js';

let tmp: string;

function makeTmp(): string {
  tmp = createTempDir('paths-io-test');
  return tmp;
}

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('ensureTinySpecDir', () => {
  it('creates .tiny-spec/current directory if it does not exist', () => {
    const dir = makeTmp();
    ensureTinySpecDir(dir);
    expect(existsSync(join(dir, TINY_SPEC_DIR, 'current'))).toBe(true);
  });

  it('is idempotent', () => {
    const dir = makeTmp();
    ensureTinySpecDir(dir);
    ensureTinySpecDir(dir);
    expect(existsSync(join(dir, TINY_SPEC_DIR, 'current'))).toBe(true);
  });
});

describe('writeSpecFile', () => {
  it('writes content to .tiny-spec/current/<filename>', async () => {
    const dir = makeTmp();
    writeSpecFile(dir, 'spec.md', '# Spec');
    const written = join(dir, TINY_SPEC_DIR, 'current', 'spec.md');
    expect(existsSync(written)).toBe(true);
    expect(await readFileOrEmpty(written)).toBe('# Spec');
  });

  it('creates dir if needed', () => {
    const dir = makeTmp();
    writeSpecFile(dir, 'plan.md', '# Plan');
    expect(existsSync(join(dir, TINY_SPEC_DIR, 'current', 'plan.md'))).toBe(true);
  });
});

describe('readSpecFile', () => {
  it('reads content from .tiny-spec/current/<filename>', () => {
    const dir = makeTmp();
    writeSpecFile(dir, 'tasks.md', '- task 1');
    expect(readSpecFile(dir, 'tasks.md')).toBe('- task 1');
  });

  it('returns null when file does not exist', () => {
    const dir = makeTmp();
    ensureTinySpecDir(dir);
    expect(readSpecFile(dir, 'missing.md')).toBeNull();
  });
});

describe('validateTaskPath', () => {
  it('resolves a valid relative path', () => {
    const dir = makeTmp();
    const resolved = validateTaskPath(dir, 'src/index.ts');
    expect(resolved).toBe(join(dir, 'src', 'index.ts'));
  });

  it('prevents directory traversal with ../', () => {
    const dir = makeTmp();
    expect(() => validateTaskPath(dir, '../outside.ts')).toThrow('escapes project directory');
  });

  it('rejects absolute paths', () => {
    const dir = makeTmp();
    expect(() => validateTaskPath(dir, '/etc/passwd')).toThrow('escapes project directory');
  });
});
