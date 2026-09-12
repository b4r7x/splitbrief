import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  isolationMarkerPath,
  isolationTreesRoot,
  isolationWorktreePath,
  isolationWorktreeRoot,
  SPLITBRIEF_DIR,
  TREES_DIR,
} from '../../../core/paths.js';
import { createGitClient } from '../../../lib/git/client.js';
import { isInsideRoot } from '../../../lib/path-confinement.js';
import {
  getChangedFilesSinceSnapshot,
  getChangedFilesSnapshot,
} from '../approval/file-snapshots/capture.js';
import { promoteStagedChanges } from '../approval/staged-project.js';
import {
  ensureIsolationWorktree,
  parseIsolationMarker,
  removeNodeModulesExclude,
} from './worktree.js';

const SESSION_ID = '2026-08-04-203317-spec-orchestrator-loop';
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
const ORIGINAL_HOME = process.env.HOME;

let repoDir: string;
let outsideDir: string;
let stateDir: string;
let homeDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'isolation-worktree-'));
  outsideDir = await mkdtemp(join(tmpdir(), 'isolation-outside-'));
  stateDir = await mkdtemp(join(tmpdir(), 'isolation-state-'));
  homeDir = await mkdtemp(join(tmpdir(), 'isolation-home-'));
  process.env.XDG_STATE_HOME = stateDir;
  process.env.HOME = homeDir;
});

afterEach(async () => {
  if (existsSync(join(repoDir, '.git'))) {
    await rm(worktreeRoot(), { recursive: true, force: true });
  }
  await rm(repoDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

const gitCommonDir = (): string => realpathSync(join(repoDir, '.git'));

const worktreeRoot = (): string => isolationWorktreeRoot(gitCommonDir());

const worktreeDir = (): string => isolationWorktreePath(gitCommonDir(), SESSION_ID.slice(0, 64));

// Model the files a test runner sees when it walks the project root. The
// isolation checkout must not add anything to this result.
const RUNNER_SKIPPED_ENTRIES = new Set(['.git', 'node_modules']);

function filesRunnersWouldDiscover(root: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || RUNNER_SKIPPED_ENTRIES.has(entry.name)) continue;
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...filesRunnersWouldDiscover(join(root, entry.name), rel));
      continue;
    }
    found.push(rel);
  }
  return found;
}

describe('ensureIsolationWorktree', () => {
  it('isolation worktree path is outside the git dir and outside the project worktree', async () => {
    delete process.env.XDG_STATE_HOME;
    createTestGitRepo(repoDir, { 'README.md': '# test\n' });

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(isInsideRoot(gitCommonDir(), realpathSync(result.worktreePath))).toBe(false);
    expect(isInsideRoot(realpathSync(repoDir), realpathSync(result.worktreePath))).toBe(false);
    expect(
      isInsideRoot(
        realpathSync(join(homedir(), '.local', 'state')),
        realpathSync(result.worktreePath),
      ),
    ).toBe(true);
  });

  it('uses an external XDG_STATE_HOME for isolation worktrees', async () => {
    process.env.XDG_STATE_HOME = outsideDir;
    createTestGitRepo(repoDir, { 'README.md': '# test\n' });

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(isInsideRoot(realpathSync(outsideDir), realpathSync(result.worktreePath))).toBe(true);
  });

  it('rejects XDG_STATE_HOME=<project> before any worktree operation', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n' });
    process.env.XDG_STATE_HOME = repoDir;
    const before = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoDir,
      encoding: 'utf-8',
    });

    await expect(
      ensureIsolationWorktree({
        projectDir: repoDir,
        sessionId: SESSION_ID,
        git: createGitClient(repoDir),
      }),
    ).rejects.toThrow(
      'Isolation worktree directory overlaps the project root or repository git root.',
    );

    expect(
      execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoDir,
        encoding: 'utf-8',
      }),
    ).toBe(before);
    expect(existsSync(isolationTreesRoot())).toBe(false);
  });

  it('rejects an external-looking XDG_STATE_HOME that resolves inside the project', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n' });
    const stateLink = join(outsideDir, 'state');
    symlinkSync(repoDir, stateLink, 'dir');
    process.env.XDG_STATE_HOME = stateLink;

    await expect(
      ensureIsolationWorktree({
        projectDir: repoDir,
        sessionId: SESSION_ID,
        git: createGitClient(repoDir),
      }),
    ).rejects.toThrow(
      'Isolation worktree directory overlaps the project root or repository git root.',
    );

    expect(existsSync(isolationTreesRoot())).toBe(false);
  });

  it('stays out of reach of a test runner discovering files from the project root', async () => {
    createTestGitRepo(repoDir, {
      'README.md': '# test\n',
      'src/slug.ts': 'export const slug = (s: string) => s;\n',
      'src/slug.test.ts': 'test("slug", () => {});\n',
    });
    const before = filesRunnersWouldDiscover(repoDir);
    expect(before).toContain('src/slug.test.ts');

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(existsSync(join(result.worktreePath, 'src', 'slug.test.ts'))).toBe(true);
    // The second copy exists and carries the same test file, yet nothing a
    // runner would walk from the project root has changed: no second
    // src/slug.test.ts to collect, count, and report twice.
    expect(filesRunnersWouldDiscover(repoDir)).toEqual(before);
  });

  // A session started inside a linked worktree has a project directory where
  // `.git` is a file rather than a directory: joining `.git` onto the project
  // path would name a file to create a directory in. The location is resolved
  // from the repository's common git directory instead, which every checkout of
  // the repository agrees on.
  it('resolves the isolation worktree when the project is itself a linked worktree', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n' });
    const sessionProject = join(repoDir, TREES_DIR, 'feature');
    execFileSync('git', ['worktree', 'add', sessionProject, '-b', 'feature'], {
      cwd: repoDir,
      stdio: 'pipe',
    });
    expect(lstatSync(join(sessionProject, '.git')).isFile()).toBe(true);

    const result = await ensureIsolationWorktree({
      projectDir: sessionProject,
      sessionId: SESSION_ID,
      git: createGitClient(sessionProject),
    });

    expect(result).toEqual({ kind: 'ready', worktreePath: worktreeDir(), reused: false });
    if (result.kind !== 'ready') return;
    expect(existsSync(join(result.worktreePath, 'README.md'))).toBe(true);
    expect(filesRunnersWouldDiscover(sessionProject)).toEqual(['README.md', 'init.txt']);
  });

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

  it('records the owning project alongside the session in the isolation marker', async () => {
    createTestGitRepo(repoDir, { 'README.md': '# test\n' });

    const result = await ensureIsolationWorktree({
      projectDir: repoDir,
      sessionId: SESSION_ID,
      git: createGitClient(repoDir),
    });

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    const marker = await readFile(isolationMarkerPath(result.worktreePath), 'utf-8');
    expect(parseIsolationMarker(marker)).toEqual({
      sessionId: SESSION_ID,
      projectDir: repoDir,
    });
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
    // No filtering: the isolation worktree lives outside the project, so it
    // contributes no status line to strip out.
    const projectStatus = (): string[] =>
      execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf-8' })
        .split('\n')
        .filter((line) => line !== '');
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
