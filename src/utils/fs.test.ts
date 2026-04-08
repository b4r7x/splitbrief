import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readFileOrEmpty,
  ensureTinySpecDir,
  writeSpecFile,
  readSpecFile,
  validateTaskPath,
} from './fs.js';

let tmp: string;

function makeTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), 'fs-test-'));
  return tmp;
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('readFileOrEmpty', () => {
  it('returns content when file exists', () => {
    const dir = makeTmp();
    const file = join(dir, 'hello.txt');
    writeFileSync(file, 'hello world', 'utf-8');
    expect(readFileOrEmpty(file)).toBe('hello world');
  });

  it('returns empty string when file does not exist', () => {
    const dir = makeTmp();
    expect(readFileOrEmpty(join(dir, 'nope.txt'))).toBe('');
  });
});

describe('ensureTinySpecDir', () => {
  it('creates .tiny-spec/current directory if it does not exist', () => {
    const dir = makeTmp();
    ensureTinySpecDir(dir);
    expect(existsSync(join(dir, '.tiny-spec', 'current'))).toBe(true);
  });

  it('is idempotent', () => {
    const dir = makeTmp();
    ensureTinySpecDir(dir);
    ensureTinySpecDir(dir);
    expect(existsSync(join(dir, '.tiny-spec', 'current'))).toBe(true);
  });
});

describe('writeSpecFile', () => {
  it('writes content to .tiny-spec/current/<filename>', () => {
    const dir = makeTmp();
    writeSpecFile(dir, 'spec.md', '# Spec');
    const written = join(dir, '.tiny-spec', 'current', 'spec.md');
    expect(existsSync(written)).toBe(true);
    expect(readFileOrEmpty(written)).toBe('# Spec');
  });

  it('creates dir if needed', () => {
    const dir = makeTmp();
    writeSpecFile(dir, 'plan.md', '# Plan');
    expect(existsSync(join(dir, '.tiny-spec', 'current', 'plan.md'))).toBe(true);
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
