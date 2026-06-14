import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTask } from '#testing/helpers/factories/task.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { TASKS_FILE, BRIEF_QUALITY_FILE, DIPTYCH_DIR, SESSIONS_DIR } from '../../../core/paths.js';
import { parseTasks } from '../../../engine/spec/parser.js';

let projectDir: string;
let sessionDirPath: string;

const SESSION_ID = 'session-1';

beforeEach(async () => {
  planEditorStore.__testReset();
  projectDir = await mkdtemp(join(tmpdir(), 'plan-editor-save-test-'));
  sessionDirPath = join(projectDir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
  await mkdir(sessionDirPath, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(projectDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

import { createSaveHandler } from './save.js';

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

describe('createSaveHandler', () => {
  it('writes tasks.md and brief-quality.json, marks clean, and calls onApprove', async () => {
    const task = makePassingTask({
      implementationSteps: ['step one'],
      tests: ['returns correct value'],
    });
    planEditorStore.initEditor([task]);
    planEditorStore.setTasks([{ ...task, title: 'Edited title' }]);

    const onApprove = vi.fn();
    const save = createSaveHandler(sessionDirPath, onApprove);
    await save();

    const written = await readFile(join(sessionDirPath, TASKS_FILE), 'utf-8');
    expect(written).toContain('id: T001');
    expect(written).toContain('Edited title');
    expect(written).toContain('step one');

    const quality = JSON.parse(await readFile(join(sessionDirPath, BRIEF_QUALITY_FILE), 'utf-8'));
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
    await createSaveHandler(sessionDirPath, onApprove)();

    const written = await readFile(join(sessionDirPath, TASKS_FILE), 'utf-8');
    const parsed = parseTasks(written);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.id).toBe(t1.id);
    expect(parsed[1]?.id).toBe(t2.id);
  });

  it('round-trip: written tasks.md parses back in editor order, not re-sorted by ID', async () => {
    const alpha = makePassingTask({
      id: 'T001',
      title: 'Alpha',
      file: 'src/alpha.ts',
      description: 'Alpha desc',
      implementationSteps: ['s1'],
      tests: ['t1'],
    });
    const beta = makePassingTask({
      id: 'T002',
      title: 'Beta',
      file: 'src/beta.ts',
      description: 'Beta desc',
      implementationSteps: ['s2'],
      tests: ['t2'],
    });
    planEditorStore.initEditor([alpha, beta]);
    planEditorStore.setTasks([beta, alpha]);

    const onApprove = vi.fn();
    await createSaveHandler(sessionDirPath, onApprove)();

    expect(onApprove).toHaveBeenCalledOnce();
    const written = await readFile(join(sessionDirPath, TASKS_FILE), 'utf-8');
    const parsed = parseTasks(written);
    expect(parsed.map((task) => task.title)).toEqual(['Beta', 'Alpha']);
  });

  it('does not call onApprove and sets saveError when tasks.md cannot be written', async () => {
    const task = makePassingTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    const blockedProject = await mkdtemp(join(tmpdir(), 'plan-editor-save-blocked-'));
    await writeFile(join(blockedProject, DIPTYCH_DIR), 'not a directory');
    const blockedSessionDir = join(blockedProject, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);

    try {
      const onApprove = vi.fn();
      await createSaveHandler(blockedSessionDir, onApprove)();

      expect(onApprove).not.toHaveBeenCalled();
      expect(planEditorStore.get().saveError).toContain('Failed to save');
    } finally {
      await rm(blockedProject, { recursive: true, force: true });
    }
  });

  itUnix('refuses to save when tasks.md is a symlink', async () => {
    const task = makePassingTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    const outside = await mkdtemp(join(tmpdir(), 'plan-editor-save-outside-'));
    try {
      await symlink(join(outside, 'tasks.md'), join(sessionDirPath, TASKS_FILE));

      const onApprove = vi.fn();
      await createSaveHandler(sessionDirPath, onApprove)();

      expect(onApprove).not.toHaveBeenCalled();
      expect(planEditorStore.get().saveError).toContain('Failed to save');
      await expect(readFile(join(outside, 'tasks.md'), 'utf-8')).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not save, approve, or mark clean when brief quality fails', async () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    planEditorStore.setTasks([{ ...task, title: 'Invalid edited title' }]);

    const onApprove = vi.fn();
    await createSaveHandler(sessionDirPath, onApprove)();

    await expect(readFile(join(sessionDirPath, TASKS_FILE), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(sessionDirPath, BRIEF_QUALITY_FILE), 'utf-8')).rejects.toThrow();
    expect(onApprove).not.toHaveBeenCalled();
    expect(planEditorStore.get().dirty).toBe(true);
    expect(planEditorStore.get().saveError).toContain('Brief quality failed');
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
    await createSaveHandler(sessionDirPath, onApprove)();

    expect(onApprove).not.toHaveBeenCalled();
    expect(planEditorStore.get().saveError).toContain('Round-trip parse failed');
  });
});
