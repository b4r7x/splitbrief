import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { isolationMarkerPath, SPLITBRIEF_DIR, TREES_DIR } from '../../../core/paths.js';
import { createGitClient } from '../../../lib/git/client.js';
import {
  getChangedFilesSinceSnapshot,
  getChangedFilesSnapshot,
} from '../approval/file-snapshots/capture.js';
import { promoteStagedChanges } from '../approval/staged-project.js';
import { ensureIsolationWorktree, removeNodeModulesExclude } from './worktree.js';

const SESSION_ID = '2026-08-04-203317-spec-orchestrator-loop';

let repoDir: string;
let outsideDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'isolation-worktree-'));
  outsideDir = await mkdtemp(join(tmpdir(), 'isolation-outside-'));
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

function worktreeDir(): string {
  return join(repoDir, TREES_DIR, SESSION_ID.slice(0, 64));
}

describe('ensureIsolationWorktree', () => {
  it('seeds a dirty source checkout so the worktree matches its working state', async () => {
    createTestGitRepo(repoDir, {
      'README.md': '# test\n',
      'a.txt': 'base\n',
      'gone.txt': 'delete me\n',
    });
    await writeFile(join(repoDir, 'a.txt'), 'edited\n');
    await writeFile(join(repoDir, 'new.txt'), 'untracked\n');
    rmSync(join(repoDir, 'gone.txt'));

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(result).toEqual({ kind: 'ready', worktreePath: worktreeDir(), reused: false });
    if (result.kind !== 'ready') return;
    expect(await readFile(join(result.worktreePath, 'a.txt'), 'utf-8')).toBe('edited\n');
    expect(await readFile(join(result.worktreePath, 'new.txt'), 'utf-8')).toBe('untracked\n');
    expect(existsSync(join(result.worktreePath, 'gone.txt'))).toBe(false);
  });

  it('reuses the same worktree for a second run of the same session via its marker', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n' });
    const first = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });
    expect(first.kind).toBe('ready');
    if (first.kind !== 'ready') return;
    await writeFile(join(first.worktreePath, 'implementer-work.txt'), 'in progress\n');

    const second = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(second).toEqual({ kind: 'ready', worktreePath: first.worktreePath, reused: true });
    expect(await readFile(join(first.worktreePath, 'implementer-work.txt'), 'utf-8')).toBe(
      'in progress\n',
    );
  });

  it.each([
    { marker: 'some-other-session-id', label: 'a foreign marker' },
    { marker: undefined, label: 'no marker' },
  ])('does not adopt a worktree carrying %s', async ({ marker }) => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n' });
    const first = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });
    expect(first.kind).toBe('ready');
    if (first.kind !== 'ready') return;
    if (marker === undefined) {
      rmSync(isolationMarkerPath(first.worktreePath));
    } else {
      await writeFile(isolationMarkerPath(first.worktreePath), marker);
    }

    const second = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(second.kind).toBe('fallback');
  });

  it('refuses a modified binary file instead of seeding corrupted content', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n', 'blob.bin': 'text\n' });
    writeFileSync(join(repoDir, 'blob.bin'), Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80, 0x81]));

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') expect(result.reason).toMatch(/binary/);
  });

  it('throws when the source checkout contains a symlinked directory', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n' });
    await mkdir(join(repoDir, 'real-dir'));
    symlinkSync(join(repoDir, 'real-dir'), join(repoDir, 'linked'), 'dir');

    await expect(
      ensureIsolationWorktree({
        projectDir: repoDir,
        sessionId: SESSION_ID,
        git: createGitClient(repoDir),
      }),
    ).rejects.toThrow(/symlink/i);
  });

  it('keeps gitignore bookkeeping out of task-visible changes around a task edit', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n', '.gitignore': 'node_modules/\n' });
    await writeFile(join(repoDir, '.gitignore'), 'node_modules/\ndist/\n');

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;

    const wtGitignore = await readFile(join(result.worktreePath, '.gitignore'), 'utf-8');
    expect(wtGitignore.split('\n')).toContain(`${SPLITBRIEF_DIR}/`);
    expect(wtGitignore.split('\n')).toContain(`${TREES_DIR}/`);

    const baseline = await getChangedFilesSnapshot(result.worktreePath);
    expect(await getChangedFilesSinceSnapshot(result.worktreePath, baseline)).toEqual([]);

    await writeFile(join(result.worktreePath, '.gitignore'), `${wtGitignore}dist2/\n`);
    expect(await getChangedFilesSinceSnapshot(result.worktreePath, baseline)).toEqual([
      '.gitignore',
    ]);
  });

  it('promotes only the task edit when the task edits the worktree gitignore', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n', '.gitignore': 'node_modules/\n' });
    const original = await readFile(join(repoDir, '.gitignore'), 'utf-8');

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;

    const baseline = await getChangedFilesSnapshot(result.worktreePath);
    const wtGitignore = await readFile(join(result.worktreePath, '.gitignore'), 'utf-8');
    await writeFile(join(result.worktreePath, '.gitignore'), `${wtGitignore}dist/\n`);
    const changed = await getChangedFilesSinceSnapshot(result.worktreePath, baseline);
    expect(changed).toEqual(['.gitignore']);

    const promoted = await promoteStagedChanges({
      targetProjectDir: repoDir,
      stagedProjectDir: result.worktreePath,
      files: changed,
      expectedCurrentContents: { '.gitignore': original },
    });

    expect(promoted).toEqual({ promotedFiles: ['.gitignore'], conflictedFiles: [] });
    expect(await readFile(join(repoDir, '.gitignore'), 'utf-8')).toBe(`${original}dist/\n`);
  });

  it('leaves the project gitignore untouched when the task edits another file', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n', '.gitignore': 'node_modules/\n' });

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;

    const baseline = await getChangedFilesSnapshot(result.worktreePath);
    await writeFile(join(result.worktreePath, 'README.md'), '# edited\n');
    const changed = await getChangedFilesSinceSnapshot(result.worktreePath, baseline);
    expect(changed).toEqual(['README.md']);

    await promoteStagedChanges({
      targetProjectDir: repoDir,
      stagedProjectDir: result.worktreePath,
      files: changed,
      expectedCurrentContents: { 'README.md': '# test\n' },
    });

    expect(await readFile(join(repoDir, '.gitignore'), 'utf-8')).toBe('node_modules/\n');
  });

  it('keeps the repository hooks reachable from inside the isolation worktree', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n' });
    await mkdir(join(repoDir, SPLITBRIEF_DIR, 'hooks'), { recursive: true });
    await writeFile(join(repoDir, SPLITBRIEF_DIR, 'hooks', 'pre-task.sh'), '#!/bin/sh\n');

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(existsSync(join(result.worktreePath, SPLITBRIEF_DIR, 'hooks', 'pre-task.sh'))).toBe(
      true,
    );
  });

  it('lets a child process started in the isolation worktree write outside it', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n' });
    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;

    const outsideTarget = join(outsideDir, 'escaped.txt');
    const script = `require('fs').writeFileSync(${JSON.stringify(outsideTarget)}, 'escaped')`;
    execFileSync(process.execPath, ['-e', script], { cwd: result.worktreePath });

    expect(await readFile(outsideTarget, 'utf-8')).toBe('escaped');
  });

  it('links the project node_modules into the worktree when the repository ignores it', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n', '.gitignore': 'node_modules\n' });
    await mkdir(join(repoDir, 'node_modules', '.bin'), { recursive: true });

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(lstatSync(join(result.worktreePath, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(result.worktreePath, 'node_modules'))).toBe(
      join(repoDir, 'node_modules'),
    );
  });

  it('keeps the worktree when node_modules is ignored as a directory', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n', '.gitignore': 'node_modules/\n' });
    await mkdir(join(repoDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(repoDir, 'node_modules', 'installed.txt'), 'dependency\n');

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(lstatSync(join(result.worktreePath, 'node_modules')).isSymbolicLink()).toBe(true);
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: result.worktreePath,
      encoding: 'utf-8',
    });
    expect(porcelain).not.toMatch(/node_modules/);
    expect(porcelain.split('\n').filter(Boolean)).toEqual([' M .gitignore']);
  });

  it('leaves the source checkout reporting exactly what it reported before the run', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n', '.gitignore': '/node_modules/\n' });
    await mkdir(join(repoDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(repoDir, 'packages', 'app', 'node_modules'), { recursive: true });
    await writeFile(join(repoDir, 'packages', 'app', 'node_modules', 'dep.txt'), 'nested\n');
    const projectStatus = (): string[] =>
      execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf-8' })
        .split('\n')
        .filter((line) => line !== '' && !line.includes(TREES_DIR));
    const before = projectStatus();
    expect(before).toEqual(['?? packages/']);

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(result.kind).toBe('ready');
    expect(projectStatus()).toEqual(before);
  });

  it('marks the shared exclude entry it writes, and takes only that entry back out', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n', '.gitignore': 'node_modules/\n' });
    await mkdir(join(repoDir, 'node_modules'), { recursive: true });
    const excludeFile = join(repoDir, '.git', 'info', 'exclude');
    const before = existsSync(excludeFile) ? await readFile(excludeFile, 'utf-8') : '';
    const excluded: string[] = [];

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
      onNodeModulesExcluded: (file) => excluded.push(file),
    });

    expect(result.kind).toBe('ready');
    expect(excluded).toEqual([join(realpathSync(repoDir), '.git', 'info', 'exclude')]);
    expect(await readFile(excludeFile, 'utf-8')).toContain(
      `# splitbrief run isolation ${SESSION_ID}`,
    );

    await removeNodeModulesExclude(excludeFile, 'a-different-session');
    expect(await readFile(excludeFile, 'utf-8')).not.toBe(before);

    await removeNodeModulesExclude(excludeFile, SESSION_ID);
    expect(await readFile(excludeFile, 'utf-8')).toBe(before);
  });

  it('writes no exclude entry when the checkout already excludes node_modules itself', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n', '.gitignore': 'node_modules/\n' });
    await mkdir(join(repoDir, 'node_modules'), { recursive: true });
    const excludeFile = join(repoDir, '.git', 'info', 'exclude');
    await writeFile(excludeFile, '/node_modules\n');
    const excluded: string[] = [];

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
      onNodeModulesExcluded: (file) => excluded.push(file),
    });

    expect(result.kind).toBe('ready');
    expect(excluded).toEqual([]);
    expect(await readFile(excludeFile, 'utf-8')).toBe('/node_modules\n');
  });

  it('falls back when the repository does not ignore node_modules, leaving its excludes alone', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n' });
    await mkdir(join(repoDir, 'node_modules'), { recursive: true });
    await writeFile(join(repoDir, 'node_modules', 'installed.txt'), 'dependency\n');

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') expect(result.reason).toMatch(/node_modules/);
    const excludeFile = join(repoDir, '.git', 'info', 'exclude');
    const excludes = existsSync(excludeFile) ? await readFile(excludeFile, 'utf-8') : '';
    expect(excludes).not.toMatch(/node_modules/);
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf-8' }),
    ).toMatch(/node_modules/);
  });

  it('keeps the worktree usable when the node_modules link cannot be created', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n', '.gitignore': 'node_modules\n' });
    await mkdir(join(repoDir, 'node_modules'), { recursive: true });
    const first = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });
    expect(first.kind).toBe('ready');
    if (first.kind !== 'ready') return;
    rmSync(join(first.worktreePath, 'node_modules'));
    symlinkSync(join(outsideDir, 'never-created'), join(first.worktreePath, 'node_modules'), 'dir');

    const second = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(second).toEqual({ kind: 'ready', worktreePath: first.worktreePath, reused: true });
    if (second.kind !== 'ready') return;
    expect(lstatSync(join(second.worktreePath, 'node_modules')).isSymbolicLink()).toBe(true);
  });
});
