import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFileOrEmpty } from '../utils/fs.js';
import {
  ensureTinySpecDir,
  writeSpecFile,
  readSpecFile,
  readSpecFileOrEmpty,
  writeProjectFile,
  validateTaskPath,
  validateFilename,
  buildSpecFrontmatter,
  setSpecMetadata,
  resetSpecMetadata,
  type SpecMetadata,
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

  it('rejects filenames with path traversal', () => {
    const dir = makeTmp();
    expect(() => writeSpecFile(dir, '../outside.md', 'x')).toThrow('Invalid filename');
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

  it('rejects filenames with path traversal', () => {
    const dir = makeTmp();
    expect(() => readSpecFile(dir, '../outside.md')).toThrow('Invalid filename');
  });
});

describe('readSpecFileOrEmpty', () => {
  it('returns content for an existing file', () => {
    const dir = makeTmp();
    writeSpecFile(dir, 'spec.md', '# My Spec');
    expect(readSpecFileOrEmpty(dir, 'spec.md')).toBe('# My Spec');
  });

  it('returns empty string for a non-existent file', () => {
    const dir = makeTmp();
    ensureTinySpecDir(dir);
    expect(readSpecFileOrEmpty(dir, 'missing.md')).toBe('');
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
    expect(fm).toContain('generated_by: tiny-spec v');
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
  beforeEach(() => {
    resetSpecMetadata();
  });

  afterEach(() => {
    resetSpecMetadata();
  });

  it('prepends frontmatter to spec files when metadata is set', () => {
    const dir = makeTmp();
    setSpecMetadata({ plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' });
    writeSpecFile(dir, 'spec.md', '# My Spec');
    const content = readSpecFile(dir, 'spec.md')!;
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('generated_by: tiny-spec v');
    expect(content).toContain('# My Spec');
  });

  it('does not prepend frontmatter to non-spec files', () => {
    const dir = makeTmp();
    setSpecMetadata({ plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' });
    writeSpecFile(dir, 'research.md', '# Research');
    expect(readSpecFile(dir, 'research.md')).toBe('# Research');
  });

  it('does not double-prepend when content already has frontmatter', () => {
    const dir = makeTmp();
    setSpecMetadata({ plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' });
    const existing = '---\ngenerated_by: tiny-spec v0.1.0\n---\n# Spec with clarifications';
    writeSpecFile(dir, 'spec.md', existing);
    const content = readSpecFile(dir, 'spec.md')!;
    const fmCount = (content.match(/generated_by:/g) ?? []).length;
    expect(fmCount).toBe(1);
  });

  it('does not prepend when metadata is not set', () => {
    const dir = makeTmp();
    writeSpecFile(dir, 'spec.md', '# Plain Spec');
    expect(readSpecFile(dir, 'spec.md')).toBe('# Plain Spec');
  });
});
