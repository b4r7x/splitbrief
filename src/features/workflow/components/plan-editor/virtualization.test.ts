import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { PlanTaskReviewMetadata } from '../../../../core/plan-review/types.js';
import { TASK_BRIEF_SECTIONS } from '../../../../stores/workflow/plan-editor-sections.js';
import { getTaskEditorRowHeight, getVisibleTaskWindow } from './virtualization.js';

function tasks(count: number) {
  return Array.from({ length: count }, (_, i) =>
    makeTask({
      id: `T${String(i + 1).padStart(3, '0')}`,
      title: `Task ${i + 1}`,
    }),
  );
}

describe('plan editor virtualization', () => {
  it('returns an empty window for empty task lists', () => {
    expect(
      getVisibleTaskWindow({
        tasks: [],
        cursor: 0,
        expandedIds: new Set(),
        metadata: new Map(),
        rowBudget: 10,
      }),
    ).toEqual({
      scrollOffset: 0,
      visibleTasks: [],
    });
  });

  it('keeps the cursor visible while filling rows around it', () => {
    const list = tasks(5);

    const result = getVisibleTaskWindow({
      tasks: list,
      cursor: 3,
      expandedIds: new Set(),
      metadata: new Map(),
      rowBudget: 9,
    });

    expect(result.scrollOffset).toBe(1);
    expect(result.visibleTasks.map((task) => task.id)).toEqual(['T002', 'T003', 'T004']);
  });

  it('accounts for expanded task detail rows', () => {
    const [task] = tasks(1);
    if (!task) throw new Error('expected task');
    const metadata: PlanTaskReviewMetadata = {
      taskId: task.id,
      workerProfile: 'local-qwen',
      selectedCostTier: 'local',
      contextFit: 'tight',
      checkpoint: 'pre-task T001',
      routingReason: 'selected local profile',
    };

    expect(getTaskEditorRowHeight(task, false, metadata)).toBe(3);
    expect(getTaskEditorRowHeight(task, true, metadata)).toBeGreaterThan(3);
  });

  it('accounts for section-list controls on the focused expanded task', () => {
    const list = tasks(2);
    const [selected] = list;
    if (!selected) throw new Error('expected task');

    const taskListHeight = getTaskEditorRowHeight(selected, true, undefined, {
      isCursor: true,
      focus: 'task-list',
    });
    const sectionListHeight = getTaskEditorRowHeight(selected, true, undefined, {
      isCursor: true,
      focus: 'section-list',
    });

    expect(sectionListHeight).toBe(taskListHeight + 1 + TASK_BRIEF_SECTIONS.length);
    expect(
      getVisibleTaskWindow({
        tasks: list,
        cursor: 0,
        expandedIds: new Set([selected.id]),
        metadata: new Map(),
        rowBudget: sectionListHeight,
        focus: 'section-list',
      }).visibleTasks.map((task) => task.id),
    ).toEqual([selected.id]);
  });

  it('accounts for multiline editing controls on the focused expanded task', () => {
    const list = tasks(2);
    const [selected] = list;
    if (!selected) throw new Error('expected task');

    const sectionListHeight = getTaskEditorRowHeight(selected, true, undefined, {
      isCursor: true,
      focus: 'section-list',
    });
    const editingHeight = getTaskEditorRowHeight(selected, true, undefined, {
      isCursor: true,
      focus: 'editing-section',
      editing: {
        taskId: selected.id,
        section: 'description',
        value: 'line 1\nline 2\nline 3',
      },
    });

    expect(editingHeight).toBe(sectionListHeight + 3);
    expect(
      getVisibleTaskWindow({
        tasks: list,
        cursor: 0,
        expandedIds: new Set([selected.id]),
        metadata: new Map(),
        rowBudget: editingHeight,
        focus: 'editing-section',
        editing: {
          taskId: selected.id,
          section: 'description',
          value: 'line 1\nline 2\nline 3',
        },
      }).visibleTasks.map((task) => task.id),
    ).toEqual([selected.id]);
  });
});
