import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { PlanTaskReviewMetadata } from '../../../../stores/workflow/plan-editor.js';
import { getTaskEditorRowHeight, getVisibleTaskWindow } from './virtualization.js';

function tasks(count: number) {
  return Array.from({ length: count }, (_, i) => makeTask({
    id: `T${String(i + 1).padStart(3, '0')}`,
    title: `Task ${i + 1}`,
  }));
}

describe('plan editor virtualization', () => {
  it('returns an empty window for empty task lists', () => {
    expect(getVisibleTaskWindow([], 0, new Set(), new Map(), 10)).toEqual({
      scrollOffset: 0,
      visibleTasks: [],
    });
  });

  it('keeps the cursor visible while filling rows around it', () => {
    const list = tasks(5);

    const result = getVisibleTaskWindow(list, 3, new Set(), new Map(), 9);

    expect(result.scrollOffset).toBe(1);
    expect(result.visibleTasks.map(task => task.id)).toEqual(['T002', 'T003', 'T004']);
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
});
