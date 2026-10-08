import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createRunIsolation } from './create.js';
import { isolationWorktreeRoot, sessionDir } from '../../../core/paths.js';
import { createSnapshot } from '../../snapshots/create.js';
import { reconcileWorkspaceToBase } from './acquisition.js';
import { hashFile } from '../../snapshots/files.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('staged attempt conformance', () => {
  it('restores a retained mode-only staged attempt across processes', async () => {
    const projectDir = createTempDir('staged-retained-mode');
    dirs.push(projectDir);
    const original = Buffer.from([0, 255, 42]);
    writeFileSync(join(projectDir, 'mode.bin'), original);
    const isolation = createRunIsolation({
      projectDir,
      sessionId: 'retained-mode',
      strategy: 'staged-copy',
      onFallback: vi.fn(),
      onRetained: vi.fn(),
    });
    const config = makeConfig();
    const attempt = await isolation.acquire({ role: 'implementer', config });
    chmodSync(join(attempt.projectDir, 'mode.bin'), 0o755);
    await attempt.retain?.();
    await isolation.dispose();
    const continued = createRunIsolation({
      projectDir,
      sessionId: 'retained-mode',
      strategy: 'staged-copy',
      onFallback: vi.fn(),
      onRetained: vi.fn(),
    });
    const opened = await continued.open({ config });
    expect(opened.keptFiles).toEqual(['mode.bin']);
    const next = await continued.acquire({ role: 'implementer', config });
    expect(next.projectDir).toBe(attempt.projectDir);
    expect(lstatSync(join(next.projectDir, 'mode.bin')).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(next.projectDir, 'mode.bin'))).toEqual(original);
    await continued.dispose();
  });

  it.each(['dependency-link', 'creation-failure'])(
    'reuses one staged copy after a %s fallback',
    async (failure) => {
      const projectDir = createTempDir('staged-fallback-reuse');
      dirs.push(projectDir);
      createTestGitRepo(projectDir, { 'source.txt': 'checkout\n' });
      mkdirSync(join(projectDir, 'node_modules', '.bin'), { recursive: true });
      const onFallback = vi.fn();
      if (failure === 'creation-failure') {
        const worktreeRoot = isolationWorktreeRoot(realpathSync(join(projectDir, '.git')));
        mkdirSync(dirname(worktreeRoot), { recursive: true });
        writeFileSync(worktreeRoot, 'not a directory');
      }
      const isolation = createRunIsolation({
        projectDir,
        sessionId: 'fallback-reuse',
        strategy: 'worktree',
        onFallback,
        onRetained: vi.fn(),
      });
      const config = makeConfig();
      const first = await isolation.acquire({ role: 'implementer', config });
      writeFileSync(join(first.projectDir, 'source.txt'), 'earlier task\n');
      expect(existsSync(join(first.projectDir, 'node_modules'))).toBe(false);
      const second = await isolation.acquire({ role: 'implementer', config });
      expect(second.projectDir).toBe(first.projectDir);
      expect(readFileSync(join(second.projectDir, 'source.txt'), 'utf8')).toBe('earlier task\n');
      expect(existsSync(join(second.projectDir, 'node_modules'))).toBe(false);
      expect(onFallback).toHaveBeenCalledOnce();
      expect(onFallback).toHaveBeenCalledWith(
        expect.stringMatching(
          failure === 'creation-failure' ? /[Nn]ot a directory/ : /does not ignore node_modules/,
        ),
      );
      expect(
        readdirSync(sessionDir(projectDir, 'fallback-reuse')).filter((entry) =>
          entry.startsWith('stage-'),
        ),
      ).toHaveLength(1);
      await isolation.dispose();
    },
  );

  it('base equals the workspace start after a checkout edit between snapshot and seed', async () => {
    const projectDir = createTempDir('staged-distinct-base');
    dirs.push(projectDir);
    const sessionId = 'distinct-base';
    writeFileSync(join(projectDir, 'source.txt'), 'earlier session baseline\n');
    const baseline = await createSnapshot({ projectDir, sessionId, phase: 'manual' });
    writeFileSync(join(projectDir, 'source.txt'), 'workspace start\n');
    const base = await createSnapshot({
      projectDir,
      sessionId,
      phase: 'manual',
      name: 'workspace-base',
    });
    expect(base.manifest.id).not.toBe(baseline.manifest.id);
    expect(base.isFirstSnapshot).toBe(false);
    writeFileSync(join(projectDir, 'source.txt'), 'checkout edit\n');
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'staged-copy',
      onFallback: vi.fn(),
      onRetained: vi.fn(),
    });
    const opened = await isolation.open({ config: makeConfig() });
    await reconcileWorkspaceToBase({
      projectDir,
      sessionId,
      snapshotId: base.manifest.id,
      workspaceDir: opened.projectDir,
      keep: opened.keptFiles,
    });
    for (const [file, hash] of Object.entries(base.manifest.fileHashes))
      expect(await hashFile(join(opened.projectDir, file))).toBe(hash);
    expect(readFileSync(join(projectDir, 'source.txt'), 'utf8')).toBe('checkout edit\n');
    await isolation.dispose();
  });

  it('rollback reverts only the current attempt, including modes, links, additions and deletions', async () => {
    const projectDir = createTempDir('staged-attempt-conformance');
    dirs.push(projectDir);
    writeFileSync(join(projectDir, 'source.txt'), 'checkout\n');
    writeFileSync(join(projectDir, 'deleted.txt'), Buffer.from([0, 255, 42]));
    const isolation = createRunIsolation({
      projectDir,
      sessionId: 'staged-cleanup',
      strategy: 'staged-copy',
      onFallback: vi.fn(),
      onRetained: vi.fn(),
    });
    const config = makeConfig();
    const first = await isolation.acquire({ role: 'implementer', config });
    writeFileSync(join(first.projectDir, 'source.txt'), 'earlier task\n');
    writeFileSync(join(first.projectDir, 'earlier.txt'), 'kept\n');
    chmodSync(join(first.projectDir, 'deleted.txt'), 0o640);
    symlinkSync('source.txt', join(first.projectDir, 'existing-link'));
    const attempt = await isolation.acquire({ role: 'implementer', config });
    writeFileSync(join(attempt.projectDir, 'source.txt'), 'checkout\n');
    chmodSync(join(attempt.projectDir, 'earlier.txt'), 0o000);
    rmSync(join(attempt.projectDir, 'deleted.txt'));
    rmSync(join(attempt.projectDir, 'existing-link'));
    symlinkSync('earlier.txt', join(attempt.projectDir, 'existing-link'));
    symlinkSync('source.txt', join(attempt.projectDir, 'new-link'));
    symlinkSync('/outside-the-workspace', join(attempt.projectDir, 'outside-link'));
    writeFileSync(join(attempt.projectDir, 'new.txt'), 'failed\n');
    attempt.cleanup();
    const next = await isolation.acquire({ role: 'implementer', config });
    expect(readFileSync(join(next.projectDir, 'source.txt'), 'utf8')).toBe('earlier task\n');
    expect(lstatSync(join(next.projectDir, 'earlier.txt')).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(next.projectDir, 'deleted.txt'))).toEqual(Buffer.from([0, 255, 42]));
    expect(lstatSync(join(next.projectDir, 'deleted.txt')).mode & 0o777).toBe(0o640);
    expect(existsSync(join(next.projectDir, 'new-link'))).toBe(false);
    expect(
      lstatSync(join(next.projectDir, 'outside-link'), { throwIfNoEntry: false }),
    ).toBeUndefined();
    expect(existsSync(join(next.projectDir, 'new.txt'))).toBe(false);
    expect(readFileSync(join(next.projectDir, 'existing-link'), 'utf8')).toBe('earlier task\n');
    expect(readFileSync(join(projectDir, 'source.txt'), 'utf8')).toBe('checkout\n');
    await isolation.dispose();
  });

  it.each([false, true])(
    'reports a kept workspace only when a cut attempt was retained: %s',
    async (retained) => {
      const projectDir = createTempDir('staged-retention-notice');
      dirs.push(projectDir);
      writeFileSync(join(projectDir, 'source.txt'), 'original\n');
      const onRetained = vi.fn();
      const config = makeConfig();
      const isolation = createRunIsolation({
        projectDir,
        sessionId: 'staged-retention',
        strategy: 'staged-copy',
        onFallback: vi.fn(),
        onRetained,
      });
      const workspace = await isolation.acquire({ role: 'implementer', config });
      if (retained) await workspace.retain?.();
      await isolation.dispose();
      expect(existsSync(workspace.projectDir)).toBe(true);
      expect(onRetained.mock.calls).toEqual(retained ? [[workspace.projectDir]] : []);
      const continuedNotice = vi.fn();
      const continued = createRunIsolation({
        projectDir,
        sessionId: 'staged-retention',
        strategy: 'staged-copy',
        onFallback: vi.fn(),
        onRetained: continuedNotice,
      });
      await continued.open({ config });
      await continued.dispose();
      expect(continuedNotice.mock.calls).toEqual(retained ? [[workspace.projectDir]] : []);
      expect(dirname(workspace.projectDir)).toMatch(/stage-/);
      expect(existsSync(sessionDir(projectDir, 'staged-retention'))).toBe(true);
    },
  );
});
