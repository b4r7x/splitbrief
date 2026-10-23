import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
import { taskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { consultHandedBackToLoop } from './retry.js';

describe('consultHandedBackToLoop', () => {
  it('hands back the first child of a split of the brief', () => {
    const parent = makeTask({ id: 'T001', status: 'in_progress' });
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [
        makeTask({ id: 'T002', parentId: taskId('T001') }),
        makeTask({ id: 'T003', parentId: taskId('T001') }),
      ],
      currentTaskIndex: 0,
    };

    expect(consultHandedBackToLoop(state, parent)).toBe(true);
  });

  it('does not hand back the next sibling when a split child passed', () => {
    const child = makeTask({ id: 'T002', status: 'in_progress', parentId: taskId('T001') });
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [{ ...child, status: 'done' }, makeTask({ id: 'T003', parentId: taskId('T001') })],
      currentTaskIndex: 1,
    };

    expect(consultHandedBackToLoop(state, child)).toBe(false);
  });

  it('hands back the first child of a split of a split child', () => {
    const child = makeTask({ id: 'T002', status: 'in_progress', parentId: taskId('T001') });
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [
        makeTask({ id: 'T004', parentId: taskId('T001') }),
        makeTask({ id: 'T005', parentId: taskId('T001') }),
        makeTask({ id: 'T003', parentId: taskId('T001') }),
      ],
      currentTaskIndex: 0,
    };

    expect(consultHandedBackToLoop(state, child)).toBe(true);
  });
});
