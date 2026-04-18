import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyCode } from './apply.js';
import { makeTask as makeBaseTask } from '#testing/helpers/factories/task.js';
import type { Task } from '../../core/schemas/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return makeBaseTask({ title: 'Test task', file: 'src/test.ts', description: 'test', ...overrides });
}

describe('applyCode', () => {
  let tempDir: string;

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

  it('modify action with search/replace markers applies patch', async () => {
    tempDir = createTempDir('impl-test');
    const filePath = join(tempDir, 'src', 'large.ts');
    const task = makeTask({ action: 'modify', file: 'src/large.ts' });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `// line ${i + 1}`);
    lines[10] = 'export const old = true;';
    writeFileSync(filePath, lines.join('\n'));

    const patchCode = '<<<<<<< SEARCH\nexport const old = true;\n=======\nexport const patched = true;\n>>>>>>> REPLACE';
    const result = await applyCode(patchCode, task, tempDir);

    expect(result.success).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('export const patched = true;');
    expect(content).not.toContain('export const old = true;');
  });

  it('search/replace returns error when search block not found', async () => {
    tempDir = createTempDir('impl-test');
    const filePath = join(tempDir, 'src', 'large2.ts');
    const task = makeTask({ action: 'modify', file: 'src/large2.ts' });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `// line ${i + 1}`);
    writeFileSync(filePath, lines.join('\n'));

    const patchCode = '<<<<<<< SEARCH\nthis text does not exist in the file\n=======\nreplacement\n>>>>>>> REPLACE';
    const result = await applyCode(patchCode, task, tempDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Search block not found');
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

  it('rejects path traversal in task file', async () => {
    tempDir = createTempDir('impl-test');
    const task = makeTask({ action: 'create', file: '../../etc/evil.ts' });
    const result = await applyCode('malicious code', task, tempDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('escapes project directory');
  });
});
