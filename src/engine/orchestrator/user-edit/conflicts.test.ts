import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { classifyUserEditConflict } from './conflicts.js';

describe('classifyUserEditConflict', () => {
  it('classifies unrelated dirty files as safe to continue', () => {
    const currentTask = makeTask({ id: 'T001', file: 'src/current.ts' });
    const conflict = classifyUserEditConflict({
      files: ['README.md'],
      currentTask,
      allTasks: [currentTask],
      currentTaskIndex: 0,
    });

    expect(conflict.kind).toBe('unrelated');
    expect(conflict.safeToContinue).toBe(true);
    expect(conflict.files).toEqual(['README.md']);
    expect(conflict.affectedTaskIds).toEqual([]);
    expect(conflict.availableActions).toContain('continue-unrelated');
  });

  it('classifies the current task file as blocking', () => {
    const currentTask = makeTask({ id: 'T001', file: 'src/current.ts' });
    const conflict = classifyUserEditConflict({
      files: ['src/current.ts'],
      currentTask,
      allTasks: [currentTask],
      currentTaskIndex: 0,
    });

    expect(conflict.kind).toBe('current-task-conflict');
    expect(conflict.safeToContinue).toBe(false);
    expect(conflict.affectedTaskIds).toEqual(['T001']);
    expect(conflict.availableActions).toEqual([
      'regenerate-rebase',
      'pause',
      'skip-current-task',
      'abort-workflow',
    ]);
  });

  it('marks future task inputs stale without blocking the current task', () => {
    const currentTask = makeTask({ id: 'T001', file: 'src/current.ts' });
    const futureTask = makeTask({ id: 'T002', file: 'src/future.ts' });
    const conflict = classifyUserEditConflict({
      files: ['src/future.ts'],
      currentTask,
      allTasks: [currentTask, futureTask],
      currentTaskIndex: 0,
    });

    expect(conflict.kind).toBe('future-task-stale-input');
    expect(conflict.safeToContinue).toBe(true);
    expect(conflict.affectedTaskIds).toEqual(['T002']);
    expect(conflict.availableActions).toEqual([
      'continue-unrelated',
      'regenerate-rebase',
      'pause',
      'abort-workflow',
    ]);
  });

  it('classifies dependency task files as blocking', () => {
    const dependencyTask = makeTask({ id: 'T001', file: 'src/dependency.ts' });
    const currentTask = makeTask({
      id: 'T002',
      file: 'src/current.ts',
      dependsOn: ['T001'],
    });
    const conflict = classifyUserEditConflict({
      files: ['src/dependency.ts'],
      currentTask,
      allTasks: [dependencyTask, currentTask],
      currentTaskIndex: 1,
    });

    expect(conflict.kind).toBe('dependency-file-conflict');
    expect(conflict.safeToContinue).toBe(false);
    expect(conflict.affectedTaskIds).toEqual(['T001']);
  });
});
