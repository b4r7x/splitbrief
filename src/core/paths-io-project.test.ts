import { describe, it, expect, afterEach, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeProjectFile, validateTaskPath, pathError } from './paths-io.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tmp: string;
const itUnix = process.platform === 'win32' ? it.skip : it;

function makeTmp(): string {
  tmp = createTempDir('paths-io-project-test');
  return tmp;
}

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('writeProjectFile', () => {
  it('creates parent directories and writes content', () => {
    const dir = makeTmp();
    writeProjectFile(dir, 'src/deep/file.ts', 'export const x = 1;');
    const written = join(dir, 'src', 'deep', 'file.ts');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf-8')).toBe('export const x = 1;');
  });

  it.each([['.git/config'], ['.splitbrief/config.yaml']])(
    'rejects model-named write into the control plane (%s) and leaves nothing on disk',
    (path) => {
      const dir = makeTmp();
      expect(() => writeProjectFile(dir, path, 'malicious')).toThrow('escapes project directory');
      expect(existsSync(join(dir, path))).toBe(false);
    },
  );
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

  it('rejects sibling directory with similar prefix', () => {
    const dir = makeTmp();
    const siblingRelative = '../' + dir.split('/').pop() + '-evil/malicious.ts';
    expect(() => validateTaskPath(dir, siblingRelative)).toThrow('escapes project directory');
  });

  it('allows root-level file path', () => {
    const dir = makeTmp();
    const resolved = validateTaskPath(dir, 'file.ts');
    expect(resolved).toBe(join(dir, 'file.ts'));
  });

  itUnix('rejects paths that write through symlinked directories outside the project', () => {
    const dir = makeTmp();
    const outside = createTempDir('paths-io-outside');
    try {
      mkdirSync(join(outside, 'target'), { recursive: true });
      symlinkSync(join(outside, 'target'), join(dir, 'linked'));

      expect(() => validateTaskPath(dir, 'linked/file.ts')).toThrow('escapes project directory');
    } finally {
      cleanupTempDir(outside);
    }
  });

  it.each([['.git/config'], ['.git/hooks/pre-commit'], ['.splitbrief/config.yaml']])(
    'rejects model-named write into the control plane (%s)',
    (path) => {
      const dir = makeTmp();
      expect(() => validateTaskPath(dir, path)).toThrow('escapes project directory');
    },
  );

  itUnix('rejects a control-plane write reaching .git through an in-repo symlink', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.git'), { recursive: true });
    symlinkSync(join(dir, '.git'), join(dir, 'evil'));
    expect(() => validateTaskPath(dir, 'evil/config')).toThrow('escapes project directory');
  });
});

describe('pathError.escapesProject factory', () => {
  test('produces AppError with kind + message + data', () => {
    const err = pathError.escapesProject('../outside.ts');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('path-escapes-project');
    expect(err.message).toContain('../outside.ts');
    expect(err.data).toEqual({ filePath: '../outside.ts' });
  });
});

describe('pathError.isEscapesProject predicate', () => {
  test('matches escapesProject output', () => {
    expect(pathError.isEscapesProject(pathError.escapesProject('../x'))).toBe(true);
  });

  test('rejects non-matching values', () => {
    expect(pathError.isEscapesProject(new Error('plain'))).toBe(false);
    expect(pathError.isEscapesProject(null)).toBe(false);
    expect(pathError.isEscapesProject(undefined)).toBe(false);
  });

  test('narrows type for data access', () => {
    const err: unknown = pathError.escapesProject('/etc/passwd');
    if (pathError.isEscapesProject(err)) {
      expect(err.data).toEqual({ filePath: '/etc/passwd' });
    } else {
      throw new Error('predicate should match');
    }
  });

  test('validateTaskPath throws pathError matched by predicate', () => {
    try {
      validateTaskPath('/tmp/project', '../../evil.ts');
      throw new Error('expected throw');
    } catch (err) {
      expect(pathError.isEscapesProject(err)).toBe(true);
    }
  });

  test('validateTaskPath preserves the specific confinement reason as cause', () => {
    const absoluteCause = (() => {
      try {
        validateTaskPath('/tmp/project', '/etc/passwd');
      } catch (err) {
        return (err as { cause?: { kind?: string } }).cause;
      }
      throw new Error('expected throw');
    })();
    expect(absoluteCause?.kind).toBe('path-confined-absolute');

    const traversalCause = (() => {
      try {
        validateTaskPath('/tmp/project', '../../evil.ts');
      } catch (err) {
        return (err as { cause?: { kind?: string } }).cause;
      }
      throw new Error('expected throw');
    })();
    expect(traversalCause?.kind).toBe('path-confined-escape');
  });
});
