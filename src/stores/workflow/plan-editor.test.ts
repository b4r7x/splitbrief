import { beforeEach, describe, expect, it } from 'vitest';
import { planEditorStore } from './plan-editor.js';
import type { PlanTaskReviewMetadata } from '../../core/plan-review/types.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { taskId } from '../../core/schemas/task.js';

function resetEditor(): void {
  planEditorStore.initEditor([]);
  planEditorStore.setRuntimeRichMode(false);
  planEditorStore.setReviewMetadata([]);
  planEditorStore.clearFlags();
  planEditorStore.markSaved();
}

describe('planEditorStore', () => {
  beforeEach(resetEditor);

  it('loads a plan as a clean snapshot and keeps runtime editor mode', () => {
    const tasks = [makeTask({ id: 'T001', title: 'Original title' }), makeTask({ id: 'T002' })];

    planEditorStore.setRuntimeRichMode(true);
    planEditorStore.initEditor(tasks);
    tasks[0] = makeTask({ id: 'T001', title: 'Mutated outside store' });

    planEditorStore.moveCursor('down');
    planEditorStore.toggleExpand('T001');
    planEditorStore.setSaveError('stale save error');
    planEditorStore.initEditor([
      makeTask({ id: 'T001', title: 'Original title' }),
      makeTask({ id: 'T002' }),
    ]);

    expect(planEditorStore.get().tasks[0]?.title).toBe('Original title');
    expect(planEditorStore.get()).toMatchObject({
      cursor: 0,
      dirty: false,
      runtimeRichMode: true,
      saveError: null,
    });
    expect(planEditorStore.get().expandedIds.size).toBe(0);
  });

  it('edits tasks as dirty snapshots, clears stale save state, and marks saved after persistence', () => {
    const task = makeTask({ id: 'T001', title: 'Original title' });
    const edited = { ...task, title: 'Edited title' };

    planEditorStore.initEditor([task]);
    planEditorStore.setReviewMetadata([
      { taskId: taskId('T001'), workerProfile: 'cheap-cloud', contextFit: 'fits' },
    ]);
    planEditorStore.setSaveError('old parse error');
    planEditorStore.setTasks([edited]);
    edited.title = 'Mutated after edit';

    expect(planEditorStore.get().tasks[0]?.title).toBe('Edited title');
    expect(planEditorStore.get()).toMatchObject({
      dirty: true,
      saveError: null,
    });
    expect(planEditorStore.get().reviewMetadata.size).toBe(0);

    planEditorStore.markSaved();
    planEditorStore.setSaveError('transient disk error');
    planEditorStore.markSaved();

    expect(planEditorStore.get()).toMatchObject({
      dirty: false,
      saveError: null,
    });

    planEditorStore.setTasks([{ ...task, title: 'Edited title' }]);
    expect(planEditorStore.get().dirty).toBe(false);
  });

  it('keeps success and error feedback mutually exclusive', () => {
    planEditorStore.setStatusMessage('saved');
    planEditorStore.setSaveError('failed');

    expect(planEditorStore.get()).toMatchObject({
      saveError: 'failed',
      statusMessage: null,
    });

    planEditorStore.setStatusMessage('saved again');

    expect(planEditorStore.get()).toMatchObject({
      saveError: null,
      statusMessage: 'saved again',
    });
  });

  it('clears review metadata when renumbered tasks reuse IDs for different work', () => {
    const first = makeTask({ id: 'T001', title: 'First task', file: 'src/first.ts' });
    const second = makeTask({ id: 'T002', title: 'Second task', file: 'src/second.ts' });
    planEditorStore.initEditor([first, second]);
    planEditorStore.setReviewMetadata([
      { taskId: taskId('T001'), workerProfile: 'local-qwen', contextFit: 'fits' },
      { taskId: taskId('T002'), workerProfile: 'frontier', contextFit: 'tight' },
    ]);

    planEditorStore.setTasks([
      { ...second, id: taskId('T001') },
      { ...first, id: taskId('T002') },
    ]);

    expect(planEditorStore.get().reviewMetadata.size).toBe(0);
  });

  it('clears expanded and flagged IDs when renumbering reuses IDs for different tasks', () => {
    const first = makeTask({ id: 'T001', title: 'First task', file: 'src/first.ts' });
    const second = makeTask({ id: 'T002', title: 'Second task', file: 'src/second.ts' });
    const third = makeTask({ id: 'T003', title: 'Third task', file: 'src/third.ts' });
    planEditorStore.initEditor([first, second, third]);
    planEditorStore.toggleExpand('T002');
    planEditorStore.toggleFlag('T002');

    planEditorStore.setTasks([
      { ...second, id: taskId('T001') },
      { ...third, id: taskId('T002') },
    ]);

    expect(planEditorStore.get().expandedIds.size).toBe(0);
    expect(planEditorStore.get().flaggedIds.size).toBe(0);
    expect(planEditorStore.getFlaggedTasks()).toEqual([]);
  });

  it('rejects stale save completions after the plan changed', () => {
    const task = makeTask({ id: 'T001', title: 'Original title' });
    planEditorStore.initEditor([task]);
    planEditorStore.setTasks([{ ...task, title: 'Edited title' }]);
    const revision = planEditorStore.get().revision;

    planEditorStore.setTasks([{ ...task, title: 'Edited again' }]);
    planEditorStore.setStatusMessage('updated Description');

    expect(planEditorStore.markSavedIfRevision(revision)).toBe(false);
    expect(planEditorStore.get()).toMatchObject({
      dirty: true,
      saveError: 'Plan changed during save. Save again to persist the latest edits.',
      statusMessage: null,
    });
  });

  it('keeps the cursor within the available task list while moving or jumping', () => {
    planEditorStore.initEditor([
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002' }),
      makeTask({ id: 'T003' }),
    ]);

    planEditorStore.moveCursor('up');
    expect(planEditorStore.get().cursor).toBe(0);

    planEditorStore.moveCursor('down');
    planEditorStore.moveCursor('down');
    planEditorStore.moveCursor('down');
    expect(planEditorStore.get().cursor).toBe(2);

    planEditorStore.setCursor(-1);
    expect(planEditorStore.get().cursor).toBe(0);

    planEditorStore.setCursor(999);
    expect(planEditorStore.get().cursor).toBe(2);

    planEditorStore.initEditor([]);
    planEditorStore.moveCursor('down');
    planEditorStore.setCursor(5);
    expect(planEditorStore.get().cursor).toBe(0);
  });

  it('toggles expanded task details open and closed', () => {
    planEditorStore.toggleExpand('T001');
    expect(planEditorStore.get().expandedIds.has('T001')).toBe(true);

    planEditorStore.toggleExpand('T001');
    expect(planEditorStore.get().expandedIds.has('T001')).toBe(false);
  });

  it('refreshes review metadata as a full cloned snapshot without dirtying the plan', () => {
    const conflict: NonNullable<PlanTaskReviewMetadata['conflict']> = {
      kind: 'current-task-conflict',
      files: ['src/a.ts'],
    };
    const metadata: PlanTaskReviewMetadata = {
      taskId: taskId('T001'),
      workerProfile: 'cheap-cloud',
      selectedCostTier: 'cheap',
      costPosture: 'Selected cheap cost tier via cheapest-capable routing',
      contextFit: 'overflow',
      conflict,
      checkpoint: 'pre-task T001',
      stale: true,
      validationStatus: 'warn',
    };

    planEditorStore.setReviewMetadata([
      metadata,
      { taskId: taskId('T002'), workerProfile: 'frontier', contextFit: 'tight' },
    ]);
    planEditorStore.setReviewMetadata([
      {
        taskId: taskId('T001'),
        workerProfile: 'local-qwen',
        selectedCostTier: 'local',
        costPosture: 'Selected local cost tier via cheapest-capable routing',
        contextFit: 'fits',
        estimatedTokens: 1200,
        contextLength: 32768,
        routingReason: 'rerouted to local-qwen',
        risk: 'low',
        conflict: { kind: 'future-task-stale-input', files: ['src/b.ts'] },
      },
    ]);
    conflict.files.push('src/mutated.ts');

    expect(planEditorStore.get().reviewMetadata.get('T001')).toMatchObject({
      workerProfile: 'local-qwen',
      selectedCostTier: 'local',
      contextFit: 'fits',
      estimatedTokens: 1200,
      contextLength: 32768,
      routingReason: 'rerouted to local-qwen',
      risk: 'low',
      conflict: { files: ['src/b.ts'] },
    });
    expect(planEditorStore.get().reviewMetadata.get('T001')).not.toMatchObject({
      checkpoint: 'pre-task T001',
      stale: true,
      validationStatus: 'warn',
    });
    expect(planEditorStore.get().reviewMetadata.has('T002')).toBe(false);
    expect(planEditorStore.get().dirty).toBe(false);
  });

  it('preserves review metadata for the same plan and clears it when plan content changes', () => {
    const reviewed = makeTask({ id: 'T001', title: 'Reviewed title' });

    planEditorStore.initEditor([reviewed]);
    planEditorStore.setReviewMetadata([
      { taskId: taskId('T001'), workerProfile: 'cheap-cloud', contextFit: 'fits' },
    ]);
    planEditorStore.initEditor([reviewed]);

    expect(planEditorStore.get().reviewMetadata.get('T001')?.workerProfile).toBe('cheap-cloud');

    planEditorStore.initEditor([{ ...reviewed, title: 'Externally edited title' }]);

    expect(planEditorStore.get().reviewMetadata.size).toBe(0);
  });

  it('upserts one task review without removing metadata for another task', () => {
    planEditorStore.setReviewMetadata([
      { taskId: taskId('T001'), workerProfile: 'cheap-cloud', contextFit: 'fits' },
      { taskId: taskId('T002'), workerProfile: 'frontier', contextFit: 'tight' },
    ]);

    planEditorStore.upsertTaskReviewMetadata({
      taskId: taskId('T001'),
      contextFit: 'overflow',
      risk: 'high',
    });

    expect(planEditorStore.get().reviewMetadata.get('T001')).toMatchObject({
      workerProfile: 'cheap-cloud',
      contextFit: 'overflow',
      risk: 'high',
    });
    expect(planEditorStore.get().reviewMetadata.get('T002')).toMatchObject({
      workerProfile: 'frontier',
      contextFit: 'tight',
    });
  });

  it('flags tasks for regeneration without dirtying the plan', () => {
    const first = makeTask({ id: 'T001' });
    const second = makeTask({ id: 'T002' });
    const third = makeTask({ id: 'T003' });
    planEditorStore.initEditor([first, second, third]);

    planEditorStore.toggleFlag('T001');
    planEditorStore.toggleFlag('T003');

    expect(planEditorStore.get().dirty).toBe(false);
    expect(planEditorStore.getFlaggedTasks().map((t) => t.id)).toEqual(['T001', 'T003']);

    planEditorStore.toggleFlag('T001');
    expect(planEditorStore.getFlaggedTasks().map((t) => t.id)).toEqual(['T003']);

    planEditorStore.clearFlags();
    expect(planEditorStore.getFlaggedTasks()).toEqual([]);
  });

  it('preserves flags only while the loaded plan is unchanged', () => {
    const task = makeTask({ id: 'T001', title: 'Original' });

    planEditorStore.initEditor([task]);
    planEditorStore.toggleFlag('T001');
    planEditorStore.initEditor([task]);

    expect(planEditorStore.get().flaggedIds.has('T001')).toBe(true);

    planEditorStore.initEditor([{ ...task, title: 'Changed' }]);

    expect(planEditorStore.get().flaggedIds.size).toBe(0);
  });

  it('moves between task and section focus for the selected expanded task', () => {
    const task = makeTask({ id: 'T001' });
    planEditorStore.initEditor([task]);

    planEditorStore.enterSectionList();
    planEditorStore.moveSectionCursor('down');

    expect(planEditorStore.get().focus).toBe('section-list');
    expect(planEditorStore.get().expandedIds.has('T001')).toBe(true);
    expect(planEditorStore.get().sectionCursor).toBe(1);

    planEditorStore.leaveSectionList();

    expect(planEditorStore.get().focus).toBe('task-list');
    expect(planEditorStore.get().sectionCursor).toBe(0);
  });

  it('edits a selected section as a dirty typed task update and clears stale metadata', () => {
    const task = makeTask({ id: 'T001', description: 'Original description' });
    planEditorStore.initEditor([task]);
    planEditorStore.setReviewMetadata([
      { taskId: taskId('T001'), workerProfile: 'cheap-cloud', contextFit: 'fits' },
    ]);

    planEditorStore.enterSectionList();
    planEditorStore.moveSectionCursor('down');
    planEditorStore.startEditingSection();
    planEditorStore.updateEditingValue('Edited description');
    planEditorStore.saveEditingSection();

    expect(planEditorStore.get()).toMatchObject({
      focus: 'section-list',
      dirty: true,
      statusMessage: 'updated Description',
    });
    expect(planEditorStore.get().tasks[0]?.description).toBe('Edited description');
    expect(planEditorStore.get().reviewMetadata.size).toBe(0);
    expect(planEditorStore.get().expandedIds.has('T001')).toBe(true);
  });

  it('cancels section editing without dirtying the task', () => {
    const task = makeTask({ id: 'T001', title: 'Original title' });
    planEditorStore.initEditor([task]);

    planEditorStore.enterSectionList();
    planEditorStore.startEditingSection();
    planEditorStore.updateEditingValue('Edited title');
    planEditorStore.cancelEditingSection();

    expect(planEditorStore.get()).toMatchObject({
      focus: 'section-list',
      editing: null,
      dirty: false,
    });
    expect(planEditorStore.get().tasks[0]?.title).toBe('Original title');
  });
});
