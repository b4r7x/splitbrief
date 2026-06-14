import { describe, it, expect, afterEach } from 'vitest';
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { applyCode } from './apply.js';
import { makeTask as makeBaseTask } from '#testing/helpers/factories/task.js';
import type { Task } from '../../core/schemas/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return makeBaseTask({
    title: 'Test task',
    file: 'src/test.ts',
    description: 'test',
    ...overrides,
  });
}

describe('applyCode', () => {
  let tempDir: string;
  const itUnix = process.platform === 'win32' ? it.skip : it;

  afterEach(() => {
    if (tempDir) cleanupTempDir(tempDir);
  });

  it('create action writes a new file', async () => {
    tempDir = createTempDir('impl-test');
    const task = makeTask({ action: 'create', file: 'src/new.ts' });
    const code = 'export const x = 1;\n';

    const result = await applyCode(code, task, tempDir);

    expect(result.success).toBe(true);
    expect(readFileSync(join(tempDir, 'src', 'new.ts'), 'utf-8')).toBe(code);
  });

  it('modify action with file <200 lines does whole-file replacement', async () => {
    tempDir = createTempDir('impl-test');
    const filePath = join(tempDir, 'src', 'existing.ts');
    const task = makeTask({ action: 'modify', file: 'src/existing.ts' });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const old = true;\n');

    const newCode = 'export const updated = true;\n';
    const result = await applyCode(newCode, task, tempDir);

    expect(result.success).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe(newCode);
  });

  it('modify action on a small file with markers patches instead of writing literal markers', async () => {
    tempDir = createTempDir('impl-test');
    const filePath = join(tempDir, 'src', 'small.ts');
    const task = makeTask({ action: 'modify', file: 'src/small.ts' });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const old = true;\nexport const keep = 1;\n');

    const patchCode =
      '<<<<<<< SEARCH\nexport const old = true;\n=======\nexport const patched = true;\n>>>>>>> REPLACE';
    const result = await applyCode(patchCode, task, tempDir);

    expect(result.success).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('export const patched = true;');
    expect(content).toContain('export const keep = 1;');
    expect(content).not.toContain('export const old = true;');
    expect(content).not.toContain('<<<<<<< SEARCH');
    expect(content).not.toContain('>>>>>>> REPLACE');
  });

  it('modify action with search/replace markers applies patch', async () => {
    tempDir = createTempDir('impl-test');
    const filePath = join(tempDir, 'src', 'large.ts');
    const task = makeTask({ action: 'modify', file: 'src/large.ts' });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `// line ${i + 1}`);
    lines[10] = 'export const old = true;';
    writeFileSync(filePath, lines.join('\n'));

    const patchCode =
      '<<<<<<< SEARCH\nexport const old = true;\n=======\nexport const patched = true;\n>>>>>>> REPLACE';
    const result = await applyCode(patchCode, task, tempDir);

    expect(result.success).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('export const patched = true;');
    expect(content).not.toContain('export const old = true;');
  });

  it('search/replace rejects an ambiguous search block matching multiple occurrences', async () => {
    tempDir = createTempDir('impl-test');
    const filePath = join(tempDir, 'src', 'repeated.ts');
    const task = makeTask({ action: 'modify', file: 'src/repeated.ts' });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `// line ${i + 1}`);
    lines[10] = 'const x = old;';
    lines[50] = 'const x = old;';
    lines[100] = 'const x = old;';
    const original = lines.join('\n');
    writeFileSync(filePath, original);

    const patchCode = '<<<<<<< SEARCH\nconst x = old;\n=======\nconst x = new;\n>>>>>>> REPLACE';
    const result = await applyCode(patchCode, task, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ambiguous search block (3 matches)');
    expect(readFileSync(filePath, 'utf-8')).toBe(original);
  });

  it('search/replace patches a single unique occurrence', async () => {
    tempDir = createTempDir('impl-test');
    const filePath = join(tempDir, 'src', 'unique.ts');
    const task = makeTask({ action: 'modify', file: 'src/unique.ts' });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `// line ${i + 1}`);
    lines[100] = 'const x = old;';
    writeFileSync(filePath, lines.join('\n'));

    const patchCode = '<<<<<<< SEARCH\nconst x = old;\n=======\nconst x = new;\n>>>>>>> REPLACE';
    const result = await applyCode(patchCode, task, tempDir);

    expect(result.success).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).not.toContain('const x = old;');
    expect(content.match(/const x = new;/g)).toHaveLength(1);
  });

  it('search/replace returns error when search block not found', async () => {
    tempDir = createTempDir('impl-test');
    const filePath = join(tempDir, 'src', 'large2.ts');
    const task = makeTask({ action: 'modify', file: 'src/large2.ts' });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `// line ${i + 1}`);
    writeFileSync(filePath, lines.join('\n'));

    const patchCode =
      '<<<<<<< SEARCH\nthis text does not exist in the file\n=======\nreplacement\n>>>>>>> REPLACE';
    const result = await applyCode(patchCode, task, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Search block not found');
    expect(result.error).toContain('line-ending-normalized');
  });

  it('search/replace with CRLF markers patches an LF file without clobbering it', async () => {
    tempDir = createTempDir('impl-test');
    const filePath = join(tempDir, 'src', 'crlf-markers.ts');
    const task = makeTask({ action: 'modify', file: 'src/crlf-markers.ts' });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `// line ${i + 1}`);
    lines[10] = 'export const old = true;';
    writeFileSync(filePath, lines.join('\n'));

    const patchCode = [
      '<<<<<<< SEARCH',
      'export const old = true;',
      '=======',
      'export const patched = true;',
      '>>>>>>> REPLACE',
    ].join('\r\n');

    const result = await applyCode(patchCode, task, tempDir);

    expect(result.success).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('export const patched = true;');
    expect(content).not.toContain('export const old = true;');
    expect(content).not.toContain('<<<<<<< SEARCH');
    expect(content).not.toContain('\r\n');
  });

  it('search/replace patches a CRLF file from LF markers and preserves CRLF endings', async () => {
    tempDir = createTempDir('impl-test');
    const filePath = join(tempDir, 'src', 'crlf-file.ts');
    const task = makeTask({ action: 'modify', file: 'src/crlf-file.ts' });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `// line ${i + 1}`);
    lines[10] = 'const target = "before";';
    writeFileSync(filePath, lines.join('\r\n'));

    const patchCode =
      '<<<<<<< SEARCH\nconst target = "before";\n=======\nconst target = "after";\n>>>>>>> REPLACE';

    const result = await applyCode(patchCode, task, tempDir);

    expect(result.success).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('const target = "after";');
    expect(content).not.toContain('const target = "before";');
    expect(content).toContain('\r\n');
    expect(content).not.toMatch(/[^\r]\n/);
  });

  it('search/replace preserves dollar sign patterns verbatim', async () => {
    tempDir = createTempDir('impl-test');
    const filePath = join(tempDir, 'src', 'dollar.ts');
    const task = makeTask({ action: 'modify', file: 'src/dollar.ts' });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `// line ${i + 1}`);
    lines[5] = 'const a = "old1";';
    lines[10] = 'const b = "old2";';
    lines[15] = 'const c = "old3";';
    lines[20] = 'const d = "old4";';
    writeFileSync(filePath, lines.join('\n'));

    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture must contain a literal ${...} to verify the patch handles template literals
    const templateLine = 'const a = `Hello ' + '${variable}`;';
    const patchCode = [
      '<<<<<<< SEARCH',
      'const a = "old1";',
      '=======',
      templateLine,
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'const b = "old2";',
      '=======',
      'const b = "$1 captured group";',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'const c = "old3";',
      '=======',
      'const c = "$& matched text";',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'const d = "old4";',
      '=======',
      'const d = "$$ escaped dollar";',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = await applyCode(patchCode, task, tempDir);

    expect(result.success).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain(templateLine);
    expect(content).toContain('const b = "$1 captured group";');
    expect(content).toContain('const c = "$& matched text";');
    expect(content).toContain('const d = "$$ escaped dollar";');
  });

  it('modify action falls back to whole-file create when the file is absent (ENOENT)', async () => {
    tempDir = createTempDir('impl-test');
    const task = makeTask({ action: 'modify', file: 'src/missing.ts' });
    const code = 'export const created = true;\n';

    const result = await applyCode(code, task, tempDir);

    expect(result.success).toBe(true);
    expect(readFileSync(join(tempDir, 'src', 'missing.ts'), 'utf-8')).toBe(code);
  });

  itUnix('modify action propagates a non-ENOENT read error instead of clobbering', async () => {
    tempDir = createTempDir('impl-test');
    const filePath = join(tempDir, 'src', 'protected.ts');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const original = true;\n');
    // Write-only: reading fails with EACCES while a write would otherwise clobber it.
    chmodSync(filePath, 0o200);

    const task = makeTask({ action: 'modify', file: 'src/protected.ts' });
    try {
      await expect(applyCode('export const clobbered = true;\n', task, tempDir)).rejects.toThrow();
    } finally {
      chmodSync(filePath, 0o600);
    }
    expect(readFileSync(filePath, 'utf-8')).toBe('export const original = true;\n');
  });

  it('rejects path traversal in task file', async () => {
    tempDir = createTempDir('impl-test');
    const task = makeTask({ action: 'create', file: '../../etc/evil.ts' });
    const result = await applyCode('malicious code', task, tempDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('escapes project directory');
  });

  itUnix('rejects writes through symlinked directories outside the project', async () => {
    tempDir = createTempDir('impl-test');
    const outside = createTempDir('impl-test-outside');
    try {
      mkdirSync(join(outside, 'target'), { recursive: true });
      symlinkSync(join(outside, 'target'), join(tempDir, 'linked'));
      const task = makeTask({ action: 'create', file: 'linked/evil.ts' });

      const result = await applyCode('malicious code', task, tempDir);

      expect(result.success).toBe(false);
      expect(result.error).toContain('escapes project directory');
      expect(existsSync(join(outside, 'target', 'evil.ts'))).toBe(false);
    } finally {
      cleanupTempDir(outside);
    }
  });

  it.each([
    ['.git/config', 'create'],
    ['.git/config', 'modify'],
    ['.diptych/sessions/x/state.json', 'create'],
    ['.diptych/sessions/x/state.json', 'modify'],
  ] as const)('refuses to write model output into the control plane (%s, %s)', async (file, action) => {
    tempDir = createTempDir('impl-test');
    const task = makeTask({ action, file });

    const result = await applyCode('[core]\n  evil = true\n', task, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('escapes project directory');
    expect(existsSync(join(tempDir, file))).toBe(false);
  });

  itUnix('refuses to modify an existing .git file (does not truncate it in place)', async () => {
    tempDir = createTempDir('impl-test');
    mkdirSync(join(tempDir, '.git'), { recursive: true });
    const gitConfig = join(tempDir, '.git', 'config');
    writeFileSync(gitConfig, '[core]\n  bare = false\n');
    const task = makeTask({ action: 'modify', file: '.git/config' });

    const result = await applyCode('[core]\n  evil = true\n', task, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('escapes project directory');
    expect(readFileSync(gitConfig, 'utf-8')).toBe('[core]\n  bare = false\n');
  });
});
