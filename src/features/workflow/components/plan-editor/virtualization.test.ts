import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { taskId } from '../../../../core/schemas/task.js';
import { TASK_BRIEF_SECTIONS } from '../../../../stores/workflow/plan-editor-sections.js';
import {
  getEditingInputRows,
  getTaskEditorRowHeight,
  getVisibleTaskWindow,
} from './virtualization.js';

describe('plan editor virtualization', () => {
  it('counts rendered expanded detail rows including evidence and routing metadata', () => {
    const task = makeTask({
      id: 'T001',
      scope: { inBounds: ['src/a.ts'], outOfBounds: ['src/b.ts'], approvedOutOfBounds: [] },
      implementationSteps: ['step one', 'step two'],
      constraints: ['keep api'],
      tests: ['npm test'],
      evidence: ['proof one', 'proof two'],
      escalation: ['stop on conflict'],
    });
    const height = getTaskEditorRowHeight(
      task,
      true,
      {
        taskId: taskId('T001'),
        workerProfile: 'local',
        contextFit: 'fits',
        routingReason: 'selected local worker',
        conflict: {
          kind: 'current-task-conflict',
          files: ['src/a.ts'],
          affectedTaskIds: ['T001'],
          note: 'manual review required',
        },
      },
      { isCursor: false, focus: 'task-list' },
    );

    expect(height).toBe(3 + 1 + 6 + 3 + 3 + 2 + 2 + 3 + 2 + 4);
  });

  it('uses bounded multiline edit rows in the selected expanded task height', () => {
    const task = makeTask({
      id: 'T001',
      implementationSteps: [],
      constraints: [],
      tests: [],
      evidence: [],
      escalation: [],
      scope: undefined,
    });
    const editing = {
      taskId: 'T001',
      section: 'description' as const,
      value: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n'),
    };

    expect(getEditingInputRows(editing.value)).toBe(6);
    const sectionListRows = 1 + TASK_BRIEF_SECTIONS.length;
    expect(
      getTaskEditorRowHeight(task, true, undefined, {
        isCursor: true,
        focus: 'editing-section',
        editing,
      }),
    ).toBe(3 + 1 + 6 + sectionListRows + 6);
  });

  it('returns no visible tasks when the row budget is zero', () => {
    expect(
      getVisibleTaskWindow({
        tasks: [makeTask({ id: 'T001' })],
        cursor: 0,
        expandedIds: new Set(),
        metadata: new Map(),
        rowBudget: 0,
      }),
    ).toEqual({ scrollOffset: 0, visibleTasks: [] });
  });
});
