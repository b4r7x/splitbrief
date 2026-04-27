import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTask } from '#testing/helpers/factories/task.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { TASKS_FILE, BRIEF_QUALITY_FILE } from '../../../core/paths.js';
import { parseTasks } from '../../../engine/spec/parser.js';

let tmpDir: string;

beforeEach(async () => {
  planEditorStore.__testReset();
  tmpDir = await mkdtemp(join(tmpdir(), 'plan-editor-save-test-'));
});

afterEach(async () => {
  try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

import { createSaveHandler } from './use-plan-editor-save.js';

describe('createSaveHandler', () => {
  it('happy path: writes tasks.md and brief-quality.json, calls onApprove', async () => {
    const task = makeTask({ implementationSteps: ['step one'], tests: ['returns correct value'] });
    planEditorStore.initEditor([task]);

    const onApprove = vi.fn();
    const save = createSaveHandler(tmpDir, onApprove);
    await save();

    const written = await readFile(join(tmpDir, TASKS_FILE), 'utf-8');
    expect(written).toContain('id: T001');
    expect(written).toContain('step one');

    const quality = JSON.parse(await readFile(join(tmpDir, BRIEF_QUALITY_FILE), 'utf-8'));
    expect(quality).toHaveProperty('passed');

    expect(onApprove).toHaveBeenCalledOnce();
  });

  it('round-trip: written tasks.md parses back to same count and IDs', async () => {
    const t1 = makeTask({ implementationSteps: ['s1'], tests: ['t1'] });
    const t2 = makeTask({ id: 'T002', title: 'B', file: 'src/b.ts', description: 'B desc', implementationSteps: ['s2'], tests: ['t2'] });
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
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);

    const onApprove = vi.fn();
    const save = createSaveHandler(join(tmpDir, 'missing-session'), onApprove);
    await save();

    expect(onApprove).not.toHaveBeenCalled();
    expect(planEditorStore.get().saveError).toContain('Failed to write');
  });

  it('catches parse errors and surfaces them as saveError', async () => {
    const t1 = makeTask({ id: 'T001', implementationSteps: ['s1'], tests: ['t1'], dependsOn: ['T002'] });
    const t2 = makeTask({ id: 'T002', title: 'B', file: 'src/b.ts', description: 'B desc', implementationSteps: ['s2'], tests: ['t2'], dependsOn: ['T001'] });
    planEditorStore.initEditor([t1, t2]);

    const onApprove = vi.fn();
    await createSaveHandler(tmpDir, onApprove)();

    expect(onApprove).not.toHaveBeenCalled();
    expect(planEditorStore.get().saveError).toContain('Round-trip parse failed');
  });

  it('accepts reordered parser output when the task ID set is unchanged', async () => {
    const t1 = makeTask({ id: 'T001', title: 'A', file: 'src/a.ts', description: 'A desc', implementationSteps: ['s1'], tests: ['t1'] });
    const t2 = makeTask({ id: 'T002', title: 'B', file: 'src/b.ts', description: 'B desc', implementationSteps: ['s2'], tests: ['t2'], dependsOn: ['T001'] });
    planEditorStore.initEditor([t2, t1]);

    const onApprove = vi.fn();
    await createSaveHandler(tmpDir, onApprove)();

    expect(onApprove).toHaveBeenCalledOnce();
    expect(planEditorStore.get().saveError).toBeNull();
  });

  it('markSaved is called on success (dirty becomes false)', async () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['test'] });
    planEditorStore.initEditor([task]);
    // Force dirty state
    planEditorStore.setTasks([task]);

    const onApprove = vi.fn();
    await createSaveHandler(tmpDir, onApprove)();

    expect(planEditorStore.get().dirty).toBe(false);
  });

  it('brief-quality.json is valid JSON with passed field', async () => {
    const task = makeTask({ implementationSteps: ['step'], tests: ['returns value'] });
    planEditorStore.initEditor([task]);

    await createSaveHandler(tmpDir, vi.fn())();

    const content = await readFile(join(tmpDir, BRIEF_QUALITY_FILE), 'utf-8');
    const obj = JSON.parse(content);
    expect(typeof obj.passed).toBe('boolean');
    expect(typeof obj.score).toBe('number');
  });
});
