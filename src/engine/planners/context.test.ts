import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildProjectContextMarkdown } from './context.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tempDir: string;
const itUnix = process.platform === 'win32' ? it.skip : it;

beforeEach(() => {
  tempDir = createTempDir('context-test');
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

describe('buildProjectContextMarkdown', () => {
  it('includes package name and scripts when package.json exists', async () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'my-app',
        description: 'A test app',
        scripts: { build: 'tsc', test: 'vitest' },
      }),
    );

    const result = await buildProjectContextMarkdown(tempDir);

    expect(result).toContain('## Package: my-app');
    expect(result).toContain('A test app');
    expect(result).toContain('`build`');
    expect(result).toContain('`tsc`');
    expect(result).toContain('`test`');
    expect(result).toContain('`vitest`');
  });

  it('includes README content when present', async () => {
    writeFileSync(join(tempDir, 'README.md'), '# My Project\n\nThis is a test project.');

    const result = await buildProjectContextMarkdown(tempDir);

    expect(result).toContain('## README (first 50 lines)');
    expect(result).toContain('# My Project');
    expect(result).toContain('This is a test project.');
  });

  it('truncates README to first 50 lines', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(join(tempDir, 'README.md'), lines.join('\n'));

    const result = await buildProjectContextMarkdown(tempDir);

    expect(result).toContain('Line 50');
    expect(result).not.toContain('Line 51');
  });

  it('lists source files when src/ directory exists', async () => {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export {}');
    writeFileSync(join(srcDir, 'utils.ts'), 'export {}');

    const result = await buildProjectContextMarkdown(tempDir);

    expect(result).toContain('## Source Files');
    expect(result).toContain('src/index.ts');
    expect(result).toContain('src/utils.ts');
  });

  it('skips hidden files and node_modules in src listing', async () => {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, '.hidden'), '');
    mkdirSync(join(srcDir, 'node_modules'));
    writeFileSync(join(srcDir, 'visible.ts'), '');

    const result = await buildProjectContextMarkdown(tempDir);

    expect(result).toContain('src/visible.ts');
    expect(result).not.toContain('.hidden');
    expect(result).not.toContain('node_modules');
  });

  it('returns empty string when project directory has no recognized files', async () => {
    const result = await buildProjectContextMarkdown(tempDir);
    expect(result).toBe('');
  });

  itUnix('does not include README content from symlink escapes', async () => {
    const outside = createTempDir('context-readme-outside');
    try {
      writeFileSync(join(outside, 'secret.md'), '# Outside README\n\nsecret content');
      symlinkSync(join(outside, 'secret.md'), join(tempDir, 'README.md'));

      const result = await buildProjectContextMarkdown(tempDir);

      expect(result).not.toContain('Outside README');
      expect(result).not.toContain('secret content');
    } finally {
      cleanupTempDir(outside);
    }
  });
});
