import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProjectFiles } from './file-listing.js';

describe('listProjectFiles', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = mkdtempProject();
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists regular files from a non-git project', async () => {
    writeFileSync(join(tmpDir, 'src', 'app.ts'), '');
    writeFileSync(join(tmpDir, 'src', 'utils.ts'), '');

    const files = await listProjectFiles(tmpDir);

    expect(files).toContain('src/app.ts');
    expect(files).toContain('src/utils.ts');
  });

  it('excludes sensitive files from the filesystem fallback', async () => {
    mkdirSync(join(tmpDir, 'config'), { recursive: true });
    writeFileSync(join(tmpDir, '.env'), 'SECRET=x');
    writeFileSync(join(tmpDir, '.env.local'), 'SECRET=y');
    writeFileSync(join(tmpDir, 'cert.pem'), '');
    writeFileSync(join(tmpDir, 'private.key'), '');
    writeFileSync(join(tmpDir, 'config', 'credentials.json'), '');
    writeFileSync(join(tmpDir, 'src', 'app.ts'), '');

    const files = await listProjectFiles(tmpDir);

    expect(files).toContain('src/app.ts');
    expect(files).not.toContain('.env');
    expect(files).not.toContain('.env.local');
    expect(files).not.toContain('cert.pem');
    expect(files).not.toContain('private.key');
    expect(files).not.toContain('config/credentials.json');
  });

  it('skips generated directories in the filesystem fallback', async () => {
    mkdirSync(join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(tmpDir, 'dist'), { recursive: true });
    writeFileSync(join(tmpDir, 'node_modules', 'pkg', 'index.js'), '');
    writeFileSync(join(tmpDir, 'dist', 'cli.js'), '');
    writeFileSync(join(tmpDir, 'src', 'app.ts'), '');

    const files = await listProjectFiles(tmpDir);

    expect(files).toContain('src/app.ts');
    expect(files.some((file) => file.includes('node_modules'))).toBe(false);
    expect(files.some((file) => file.startsWith('dist/'))).toBe(false);
  });

  it('skips caller-injected directories in the filesystem fallback', async () => {
    mkdirSync(join(tmpDir, '.diptych', 'sessions', 'abc'), { recursive: true });
    writeFileSync(join(tmpDir, '.diptych', 'sessions', 'abc', 'state.json'), '');
    writeFileSync(join(tmpDir, 'src', 'app.ts'), '');

    const files = await listProjectFiles(tmpDir, {
      excludePatterns: [/(?:^|\/)\.diptych\/sessions\//],
      skipRelativeDirs: ['.diptych/sessions'],
    });

    expect(files).toContain('src/app.ts');
    expect(files.some((file) => file.startsWith('.diptych/sessions/'))).toBe(false);
  });

  it('uses git listing when available so ignored files are omitted', async () => {
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    writeFileSync(join(tmpDir, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(tmpDir, 'ignored.txt'), '');
    writeFileSync(join(tmpDir, 'src', 'app.ts'), '');

    const files = await listProjectFiles(tmpDir);

    expect(files).toContain('src/app.ts');
    expect(files).not.toContain('ignored.txt');
  });

  it('lists a non-ASCII filename verbatim from the git listing', async () => {
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    writeFileSync(join(tmpDir, 'src', 'café.ts'), '');

    const files = await listProjectFiles(tmpDir);

    expect(files).toContain('src/café.ts');
  });
});

function mkdtempProject(): string {
  return mkdtempSync(join(tmpdir(), 'diptych-files-'));
}
