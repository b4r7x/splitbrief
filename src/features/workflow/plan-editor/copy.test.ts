import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { SECURE_FILE_MODE } from '../../../lib/fs.js';
import {
  copyPlanEditorSelection,
  formatTaskCopyText,
  formatTaskSectionCopyText,
  runClipboardCommand,
} from './copy.js';

let sessionDir: string;
const itUnix = process.platform === 'win32' ? it.skip : it;

beforeEach(async () => {
  sessionDir = await mkdtemp(join(tmpdir(), 'plan-editor-copy-test-'));
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

describe('plan editor copy helpers', () => {
  it('serializes the selected full task as canonical task markdown', () => {
    const task = makeTask({
      id: 'T001',
      title: 'Copy this task',
      description: 'Full source description',
    });

    const text = formatTaskCopyText(task);

    expect(text).toContain('id: T001');
    expect(text).toContain('title: Copy this task');
    expect(text).toContain('Full source description');
  });

  it('serializes the selected section as the underlying full section text', () => {
    const task = makeTask({
      tests: ['first exact assertion', 'second exact assertion'],
    });

    expect(formatTaskSectionCopyText(task, 'tests')).toBe(
      'first exact assertion\nsecond exact assertion',
    );
  });

  it('writes session-local fallback selection text when clipboard commands fail', async () => {
    const task = makeTask({ id: 'T001', title: 'Fallback task' });
    const runClipboardCommand = vi.fn().mockResolvedValue(false);

    const result = await copyPlanEditorSelection({
      sessionDirPath: sessionDir,
      task,
      platform: 'linux',
      runClipboardCommand,
    });

    expect(result.clipboard).toBe(false);
    expect(result.path).toBe(join(sessionDir, 'selection.txt'));
    expect(result.message).toContain('selection.txt');
    expect(await readFile(result.path, 'utf-8')).toContain('title: Fallback task');
    expect(runClipboardCommand).toHaveBeenCalledWith('wl-copy', [], expect.any(String));
    expect(runClipboardCommand).toHaveBeenCalledWith(
      'xclip',
      ['-selection', 'clipboard'],
      expect.any(String),
    );
  });

  it('reports clipboard success while preserving the fallback file', async () => {
    const task = makeTask({ id: 'T001', constraints: ['copy the real constraint'] });

    const result = await copyPlanEditorSelection({
      sessionDirPath: sessionDir,
      task,
      section: 'constraints',
      platform: 'darwin',
      runClipboardCommand: vi.fn().mockResolvedValue(true),
    });

    expect(result.clipboard).toBe(true);
    expect(result.message).toContain('fallback');
    expect(await readFile(result.path, 'utf-8')).toBe('copy the real constraint');
  });

  it('corrects broad permissions on the fallback selection file', async () => {
    const task = makeTask({ id: 'T001', title: 'Private selection' });
    const path = join(sessionDir, 'selection.txt');
    await writeFile(path, 'old value', { mode: 0o666 });
    await chmod(path, 0o666);

    const result = await copyPlanEditorSelection({
      sessionDirPath: sessionDir,
      task,
      platform: 'linux',
      runClipboardCommand: vi.fn().mockResolvedValue(false),
    });

    expect(result.path).toBe(path);
    expect((await stat(path)).mode & 0o777).toBe(SECURE_FILE_MODE);
    expect(await readFile(path, 'utf-8')).toContain('title: Private selection');
  });

  itUnix('rejects an existing symlink fallback target', async () => {
    const task = makeTask({ id: 'T001', title: 'Do not follow symlink' });
    const target = join(sessionDir, 'target.txt');
    const link = join(sessionDir, 'selection.txt');
    await writeFile(target, 'target stays unchanged', 'utf-8');
    await symlink(target, link);

    await expect(
      copyPlanEditorSelection({
        sessionDirPath: sessionDir,
        task,
        platform: 'linux',
        runClipboardCommand: vi.fn().mockResolvedValue(false),
      }),
    ).rejects.toThrow(/refusing to write through symlink/);
    expect(await readFile(target, 'utf-8')).toBe('target stays unchanged');
  });

  it('treats early clipboard process stdin close as a fallbackable failure', async () => {
    await expect(runClipboardCommand('false', [], 'payload')).resolves.toBe(false);
  });
});
