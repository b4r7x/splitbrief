import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { classifyUserEditConflict } from './conflicts.js';

describe('classifyUserEditConflict', () => {
  it('classifies unrelated dirty files as safe to continue', () => {
    const currentTask = makeTask({ id: 'T001', file: 'src/current.ts' });
    const conflict = classifyUserEditConflict({
      files: ['README.md'],
      currentTask,
      currentTaskInFlight: false,
      allTasks: [currentTask],
      currentTaskIndex: 0,
    });

    expect(conflict.kind).toBe('unrelated');
    expect(conflict.safeToContinue).toBe(true);
    expect(conflict.files).toEqual(['README.md']);
    expect(conflict.affectedTaskIds).toEqual([]);
    expect(conflict.availableActions).toContain('continue-unrelated');
  });

  it('classifies a file of the brief in flight as blocking', () => {
    const currentTask = makeTask({ id: 'T001', file: 'src/current.ts' });
    const conflict = classifyUserEditConflict({
      files: ['src/current.ts'],
      currentTask,
      currentTaskInFlight: true,
      allTasks: [currentTask],
      currentTaskIndex: 0,
    });

    expect(conflict.kind).toBe('current-task-conflict');
    expect(conflict.safeToContinue).toBe(false);
    expect(conflict.affectedTaskIds).toEqual(['T001']);
    expect(conflict.availableActions).toEqual(['pause', 'skip-current-task', 'abort-workflow']);
  });

  it('classifies a file of a brief that has not started as its stale input', () => {
    const currentTask = makeTask({ id: 'T001', file: 'src/current.ts' });
    const conflict = classifyUserEditConflict({
      files: ['src/current.ts'],
      currentTask,
      currentTaskInFlight: false,
      allTasks: [currentTask],
      currentTaskIndex: 0,
    });

    expect(conflict.kind).toBe('future-task-stale-input');
    expect(conflict.safeToContinue).toBe(true);
    expect(conflict.affectedTaskIds).toEqual(['T001']);
    expect(conflict.availableActions).toEqual(['continue-unrelated', 'pause', 'abort-workflow']);
  });

  it('classifies a second declared file and a prose in-bounds bullet as current-task conflicts', () => {
    const currentTask = makeTask({
      id: 'T001',
      file: 'src/current.ts',
      files: ['src/current.ts', 'src/current.test.ts'],
      scope: { inBounds: ['`src/x.ts` — the union collapse'] },
    });
    const conflict = classifyUserEditConflict({
      files: ['src/current.test.ts', 'src/x.ts'],
      currentTask,
      currentTaskInFlight: true,
      allTasks: [currentTask],
      currentTaskIndex: 0,
    });

    expect(conflict.kind).toBe('current-task-conflict');
    expect(conflict.affectedTaskIds).toEqual(['T001']);
  });

  it('marks future task inputs stale without blocking the current task', () => {
    const currentTask = makeTask({ id: 'T001', file: 'src/current.ts' });
    const futureTask = makeTask({ id: 'T002', file: 'src/future.ts' });
    const conflict = classifyUserEditConflict({
      files: ['src/future.ts'],
      currentTask,
      currentTaskInFlight: false,
      allTasks: [currentTask, futureTask],
      currentTaskIndex: 0,
    });

    expect(conflict.kind).toBe('future-task-stale-input');
    expect(conflict.safeToContinue).toBe(true);
    expect(conflict.affectedTaskIds).toEqual(['T002']);
    expect(conflict.availableActions).toEqual(['continue-unrelated', 'pause', 'abort-workflow']);
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
      currentTaskInFlight: false,
      allTasks: [dependencyTask, currentTask],
      currentTaskIndex: 1,
    });

    expect(conflict.kind).toBe('dependency-file-conflict');
    expect(conflict.safeToContinue).toBe(false);
    expect(conflict.affectedTaskIds).toEqual(['T001']);
  });
});
