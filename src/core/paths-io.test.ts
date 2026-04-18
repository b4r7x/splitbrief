import { describe, it, expect, afterEach, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFileOrEmpty } from '../lib/fs.js';
import {
  ensureDiptychDir,
  ensureSessionDir,
  writeSpecFile,
  readSpecFile,
  readSpecFileOrEmpty,
  writeProjectFile,
  validateTaskPath,
  validateFilename,
  buildSpecFrontmatter,
  pathError,
  type SpecMetadata,
} from './paths-io.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from './paths.js';

let tmp: string;
const SESSION_ID = '2024-01-01-test-feature';

function makeTmp(): string {
  tmp = createTempDir('paths-io-test');
  return tmp;
}

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('ensureDiptychDir', () => {
  it('creates .diptych directory if it does not exist', () => {
    const dir = makeTmp();
    ensureDiptychDir(dir);
    expect(existsSync(join(dir, DIPTYCH_DIR))).toBe(true);
  });

  it('is idempotent', () => {
    const dir = makeTmp();
    ensureDiptychDir(dir);
    ensureDiptychDir(dir);
    expect(existsSync(join(dir, DIPTYCH_DIR))).toBe(true);
  });
});

describe('ensureSessionDir', () => {
  it('creates .diptych/sessions/<id> directory', () => {
    const dir = makeTmp();
    ensureSessionDir(dir, SESSION_ID);
    expect(existsSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID))).toBe(true);
  });

  it('is idempotent', () => {
    const dir = makeTmp();
    ensureSessionDir(dir, SESSION_ID);
    ensureSessionDir(dir, SESSION_ID);
    expect(existsSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID))).toBe(true);
  });
});

describe('writeSpecFile', () => {
  it('writes content to .diptych/sessions/<id>/<filename>', async () => {
    const dir = makeTmp();
    writeSpecFile(dir, SESSION_ID, 'spec.md', '# Spec');
    const written = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'spec.md');
    expect(existsSync(written)).toBe(true);
    expect(await readFileOrEmpty(written)).toBe('# Spec');
  });

  it('creates dir if needed', () => {
    const dir = makeTmp();
    writeSpecFile(dir, SESSION_ID, 'plan.md', '# Plan');
    expect(existsSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'plan.md'))).toBe(true);
  });

  it('rejects filenames with path traversal', () => {
    const dir = makeTmp();
    expect(() => writeSpecFile(dir, SESSION_ID, '../outside.md', 'x')).toThrow('Invalid filename');
  });
});

describe('readSpecFile', () => {
  it('reads content from .diptych/sessions/<id>/<filename>', () => {
    const dir = makeTmp();
    writeSpecFile(dir, SESSION_ID, 'tasks.md', '- task 1');
    expect(readSpecFile(dir, SESSION_ID, 'tasks.md')).toBe('- task 1');
  });

  it('returns null when file does not exist', () => {
    const dir = makeTmp();
    ensureSessionDir(dir, SESSION_ID);
    expect(readSpecFile(dir, SESSION_ID, 'missing.md')).toBeNull();
  });

  it('rejects filenames with path traversal', () => {
    const dir = makeTmp();
    expect(() => readSpecFile(dir, SESSION_ID, '../outside.md')).toThrow('Invalid filename');
  });
});

describe('readSpecFileOrEmpty', () => {
  it('returns content for an existing file', () => {
    const dir = makeTmp();
    writeSpecFile(dir, SESSION_ID, 'spec.md', '# My Spec');
    expect(readSpecFileOrEmpty(dir, SESSION_ID, 'spec.md')).toBe('# My Spec');
  });

  it('returns empty string for a non-existent file', () => {
    const dir = makeTmp();
    ensureSessionDir(dir, SESSION_ID);
    expect(readSpecFileOrEmpty(dir, SESSION_ID, 'missing.md')).toBe('');
  });
});

describe('validateFilename', () => {
  it('accepts a plain filename', () => {
    expect(() => validateFilename('spec.md')).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateFilename('')).toThrow("Invalid filename ''");
  });

  it('rejects whitespace-only string', () => {
    expect(() => validateFilename('   ')).toThrow('Invalid filename');
  });

  it('rejects filenames with ..', () => {
    expect(() => validateFilename('../etc/passwd')).toThrow('Invalid filename');
  });

  it('rejects filenames with forward slash', () => {
    expect(() => validateFilename('sub/spec.md')).toThrow('Invalid filename');
  });

  it('rejects filenames with backslash', () => {
    expect(() => validateFilename('sub\\spec.md')).toThrow('Invalid filename');
  });
});

describe('writeProjectFile', () => {
  it('creates parent directories and writes content', () => {
    const dir = makeTmp();
    writeProjectFile(dir, 'src/deep/file.ts', 'export const x = 1;');
    const written = join(dir, 'src', 'deep', 'file.ts');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf-8')).toBe('export const x = 1;');
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
});

describe('buildSpecFrontmatter', () => {
  const fullMeta: SpecMetadata = {
    plannerTool: 'claude-code',
    plannerModel: 'opus-4',
    implementerTool: 'ollama',
    implementerModel: 'qwen3:32b',
    mode: 'standard',
  };

  it('includes all fields when provided', () => {
    const fm = buildSpecFrontmatter(fullMeta);
    expect(fm).toContain('generated_by: diptych v');
    expect(fm).toContain('planner: claude-code (opus-4)');
    expect(fm).toContain('implementer: ollama (qwen3:32b)');
    expect(fm).toContain('mode: standard');
    expect(fm).toContain('created_at: ');
  });

  it('omits optional model fields when undefined', () => {
    const fm = buildSpecFrontmatter({
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      mode: 'quick',
    });
    expect(fm).toContain('planner: claude-code');
    expect(fm).not.toContain('planner: claude-code (');
    expect(fm).toContain('implementer: ollama');
    expect(fm).not.toContain('implementer: ollama (');
    expect(fm).toContain('mode: quick');
  });

  it('starts with --- and ends with ---', () => {
    const fm = buildSpecFrontmatter(fullMeta);
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm).toMatch(/\n---\n$/);
  });
});

describe('writeSpecFile with metadata', () => {
  const meta: SpecMetadata = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' };

  it('prepends frontmatter to spec files when metadata is passed', () => {
    const dir = makeTmp();
    writeSpecFile(dir, SESSION_ID, 'spec.md', '# My Spec', meta);
    const content = readSpecFile(dir, SESSION_ID, 'spec.md');
    if (content === null) throw new Error('expected spec file to be present');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('generated_by: diptych v');
    expect(content).toContain('# My Spec');
  });

  it('does not prepend frontmatter to non-spec files', () => {
    const dir = makeTmp();
    writeSpecFile(dir, SESSION_ID, 'research.md', '# Research', meta);
    expect(readSpecFile(dir, SESSION_ID, 'research.md')).toBe('# Research');
  });

  it('does not double-prepend when content already has frontmatter', () => {
    const dir = makeTmp();
    const existing = '---\ngenerated_by: diptych v0.1.0\n---\n# Spec with clarifications';
    writeSpecFile(dir, SESSION_ID, 'spec.md', existing, meta);
    const content = readSpecFile(dir, SESSION_ID, 'spec.md');
    if (content === null) throw new Error('expected spec file to be present');
    const fmCount = (content.match(/generated_by:/g) ?? []).length;
    expect(fmCount).toBe(1);
  });

  it('does not prepend when metadata is not passed', () => {
    const dir = makeTmp();
    writeSpecFile(dir, SESSION_ID, 'spec.md', '# Plain Spec');
    expect(readSpecFile(dir, SESSION_ID, 'spec.md')).toBe('# Plain Spec');
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
});
