import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTask } from '#testing/helpers/factories/task.js';
import { planEditorStore } from '../../stores/workflow/plan-editor.js';
import { TASKS_FILE, BRIEF_QUALITY_FILE } from '../../core/paths.js';
import { parseTasks } from '../../engine/spec/parser.js';

let tmpDir: string;

beforeEach(async () => {
  planEditorStore.__testReset();
  tmpDir = await mkdtemp(join(tmpdir(), 'plan-editor-save-test-'));
});

afterEach(async () => {
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

import { createSaveHandler } from './plan-editor-save.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

function makePassingTask(overrides?: Parameters<typeof makeTask>[0]) {
  return makeTask({
    implementationSteps: ['Implement the module behavior'],
    tests: ['returns the expected greeting'],
    scope: { inBounds: ['src/hello.ts'] },
    evidence: ['Focused test output is captured'],
    ...overrides,
  });
}

async function waitForPromise<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('createSaveHandler', () => {
  it('writes tasks.md and brief-quality.json, marks clean, and calls onApprove', async () => {
    const task = makePassingTask({
      implementationSteps: ['step one'],
      tests: ['returns correct value'],
    });
    planEditorStore.initEditor([task]);
    planEditorStore.setTasks([{ ...task, title: 'Edited title' }]);

    const onApprove = vi.fn();
    const save = createSaveHandler(tmpDir, onApprove);
    await save();

    const written = await readFile(join(tmpDir, TASKS_FILE), 'utf-8');
    expect(written).toContain('id: T001');
    expect(written).toContain('Edited title');
    expect(written).toContain('step one');

    const quality = JSON.parse(await readFile(join(tmpDir, BRIEF_QUALITY_FILE), 'utf-8'));
    expect(typeof quality.passed).toBe('boolean');
    expect(typeof quality.score).toBe('number');

    expect(onApprove).toHaveBeenCalledOnce();
    expect(planEditorStore.get().dirty).toBe(false);
  });

  it('round-trip: written tasks.md parses back to same count and IDs', async () => {
    const t1 = makePassingTask({ implementationSteps: ['s1'], tests: ['t1'] });
    const t2 = makePassingTask({
      id: 'T002',
      title: 'B',
      file: 'src/b.ts',
      description: 'B desc',
      implementationSteps: ['s2'],
      tests: ['t2'],
    });
    planEditorStore.initEditor([t1, t2]);

    const onApprove = vi.fn();
    await createSaveHandler(tmpDir, onApprove)();

    const written = await readFile(join(tmpDir, TASKS_FILE), 'utf-8');
    const parsed = parseTasks(written);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.id).toBe(t1.id);
    expect(parsed[1]?.id).toBe(t2.id);
  });

  it('does not call onApprove and sets saveError when tasks.md cannot be written', async () => {
    const task = makePassingTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    const onApprove = vi.fn();
    const save = createSaveHandler(join(tmpDir, 'missing-session'), onApprove);
    await save();

    expect(onApprove).not.toHaveBeenCalled();
    expect(planEditorStore.get().saveError).toContain('Failed to write');
  });

  itUnix('refuses to save when tasks.md.tmp is a symlink', async () => {
    const task = makePassingTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    const outside = await mkdtemp(join(tmpdir(), 'plan-editor-save-outside-'));
    try {
      await symlink(join(outside, 'tasks.md'), join(tmpDir, `${TASKS_FILE}.tmp`));

      const onApprove = vi.fn();
      await createSaveHandler(tmpDir, onApprove)();

      expect(onApprove).not.toHaveBeenCalled();
      expect(planEditorStore.get().saveError).toContain('Refusing to write through symlink');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not save, approve, or mark clean when brief quality fails', async () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    planEditorStore.setTasks([{ ...task, title: 'Invalid edited title' }]);

    const onApprove = vi.fn();
    await createSaveHandler(tmpDir, onApprove)();

    await expect(readFile(join(tmpDir, TASKS_FILE), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(tmpDir, BRIEF_QUALITY_FILE), 'utf-8')).rejects.toThrow();
    expect(onApprove).not.toHaveBeenCalled();
    expect(planEditorStore.get().dirty).toBe(true);
    expect(planEditorStore.get().saveError).toContain('Brief quality failed');
  });

  it('does not approve or mark clean when the plan changes during a pending save', async () => {
    const task = makePassingTask({ id: 'T001', title: 'Original title' });
    planEditorStore.initEditor([task]);
    planEditorStore.setTasks([{ ...task, title: 'Edited before save' }]);

    let releaseWrite = () => {};
    let markWriteStarted = () => {};
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const writeMayContinue = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const onApprove = vi.fn();
    const savePromise = createSaveHandler(tmpDir, onApprove, {
      rename,
      writeFile: async (file, data, options) => {
        if (String(file).endsWith(`${TASKS_FILE}.tmp`)) {
          markWriteStarted();
          await writeMayContinue;
        }
        return writeFile(file, data, options);
      },
    })();
    await waitForPromise(writeStarted, 'tasks.md.tmp write was not reached');

    planEditorStore.setTasks([{ ...task, title: 'Changed during save' }]);
    releaseWrite();
    await savePromise;

    await expect(readFile(join(tmpDir, TASKS_FILE), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(tmpDir, BRIEF_QUALITY_FILE), 'utf-8')).rejects.toThrow();
    expect(onApprove).not.toHaveBeenCalled();
    expect(planEditorStore.get()).toMatchObject({
      dirty: true,
      saveError: 'Plan changed during save. Save again to persist the latest edits.',
    });
  });

  it('catches parse errors and surfaces them as saveError', async () => {
    const t1 = makePassingTask({
      id: 'T001',
      implementationSteps: ['s1'],
      tests: ['t1'],
      dependsOn: ['T002'],
    });
    const t2 = makePassingTask({
      id: 'T002',
      title: 'B',
      file: 'src/b.ts',
      description: 'B desc',
      implementationSteps: ['s2'],
      tests: ['t2'],
      dependsOn: ['T001'],
    });
    planEditorStore.initEditor([t1, t2]);

    const onApprove = vi.fn();
    await createSaveHandler(tmpDir, onApprove)();

    expect(onApprove).not.toHaveBeenCalled();
    expect(planEditorStore.get().saveError).toContain('Round-trip parse failed');
  });
});
