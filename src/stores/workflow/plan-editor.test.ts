import { beforeEach, describe, expect, it } from 'vitest';
import { planEditorStore } from './plan-editor.js';
import { makeTask } from '#testing/helpers/factories/task.js';

describe('planEditorStore', () => {
  beforeEach(() => planEditorStore.__testReset());

  describe('initEditor', () => {
    it('resets cursor to 0 and dirty to false', () => {
      const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
      planEditorStore.initEditor(tasks);
      planEditorStore.moveCursor('down');
      planEditorStore.setTasks(tasks);
      planEditorStore.initEditor(tasks);
      expect(planEditorStore.get().cursor).toBe(0);
      expect(planEditorStore.get().dirty).toBe(false);
    });

    it('sets tasks correctly', () => {
      const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
      planEditorStore.initEditor(tasks);
      expect(planEditorStore.get().tasks).toEqual(tasks);
    });

    it('preserves runtime rich mode while loading tasks', () => {
      const tasks = [makeTask({ id: 'T001' })];
      planEditorStore.setRuntimeRichMode(true);
      planEditorStore.initEditor(tasks);
      expect(planEditorStore.get().runtimeRichMode).toBe(true);
    });
  });

  describe('moveCursor', () => {
    it('increments cursor on down, clamped at tasks.length - 1', () => {
      const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
      planEditorStore.initEditor(tasks);
      planEditorStore.moveCursor('down');
      expect(planEditorStore.get().cursor).toBe(1);
      planEditorStore.moveCursor('down');
      expect(planEditorStore.get().cursor).toBe(1);
    });

    it('decrements cursor on up, clamped at 0', () => {
      const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
      planEditorStore.initEditor(tasks);
      planEditorStore.moveCursor('up');
      expect(planEditorStore.get().cursor).toBe(0);
      planEditorStore.moveCursor('down');
      planEditorStore.moveCursor('up');
      expect(planEditorStore.get().cursor).toBe(0);
    });

    it('is a no-op when tasks is empty', () => {
      expect(planEditorStore.get().tasks).toHaveLength(0);
      planEditorStore.moveCursor('down');
      expect(planEditorStore.get().cursor).toBe(0);
      planEditorStore.moveCursor('up');
      expect(planEditorStore.get().cursor).toBe(0);
    });
  });

  describe('setTasks', () => {
    it('replaces the task list and sets dirty to true', () => {
      const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
      planEditorStore.setTasks(tasks);
      expect(planEditorStore.get().tasks).toEqual(tasks);
      expect(planEditorStore.get().dirty).toBe(true);
    });

    it('does not mark dirty when the task list is unchanged', () => {
      const tasks = [makeTask({ id: 'T001' })];
      planEditorStore.initEditor(tasks);
      planEditorStore.setTasks(tasks);
      expect(planEditorStore.get().dirty).toBe(false);
    });

    it('clears stale save errors after a successful task edit', () => {
      const task = makeTask({ id: 'T001' });
      planEditorStore.initEditor([task]);
      planEditorStore.setSaveError('old parse error');
      planEditorStore.setTasks([{ ...task, title: 'Edited title' }]);
      expect(planEditorStore.get().saveError).toBeNull();
    });
  });

  describe('toggleExpand', () => {
    it('adds an ID not in the set', () => {
      planEditorStore.toggleExpand('T001');
      expect(planEditorStore.get().expandedIds.has('T001')).toBe(true);
    });

    it('removes an ID already in the set', () => {
      planEditorStore.toggleExpand('T001');
      planEditorStore.toggleExpand('T001');
      expect(planEditorStore.get().expandedIds.has('T001')).toBe(false);
    });

    it('creates a new Set on each toggle (no in-place mutation)', () => {
      const before = planEditorStore.get().expandedIds;
      planEditorStore.toggleExpand('T001');
      const after = planEditorStore.get().expandedIds;
      expect(before).not.toBe(after);
    });
  });

  describe('setCursor', () => {
    it('sets cursor to an absolute index', () => {
      const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' }), makeTask({ id: 'T003' })];
      planEditorStore.initEditor(tasks);
      planEditorStore.setCursor(2);
      expect(planEditorStore.get().cursor).toBe(2);
    });

    it('clamps negative index to 0', () => {
      const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
      planEditorStore.initEditor(tasks);
      planEditorStore.setCursor(-1);
      expect(planEditorStore.get().cursor).toBe(0);
    });

    it('clamps out-of-range index to tasks.length - 1', () => {
      const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' }), makeTask({ id: 'T003' })];
      planEditorStore.initEditor(tasks);
      planEditorStore.setCursor(999);
      expect(planEditorStore.get().cursor).toBe(2);
    });

    it('sets cursor to 0 on empty list', () => {
      planEditorStore.setCursor(0);
      expect(planEditorStore.get().cursor).toBe(0);
    });
  });

  describe('setRuntimeRichMode', () => {
    it('sets runtimeRichMode to true and back to false', () => {
      planEditorStore.setRuntimeRichMode(true);
      expect(planEditorStore.get().runtimeRichMode).toBe(true);
      planEditorStore.setRuntimeRichMode(false);
      expect(planEditorStore.get().runtimeRichMode).toBe(false);
    });
  });

  describe('setSaveError', () => {
    it('sets the error string', () => {
      planEditorStore.setSaveError('disk full');
      expect(planEditorStore.get().saveError).toBe('disk full');
    });

    it('clears the error when set to null', () => {
      planEditorStore.setSaveError('disk full');
      planEditorStore.setSaveError(null);
      expect(planEditorStore.get().saveError).toBeNull();
    });
  });

  describe('markSaved', () => {
    it('sets dirty to false and saveError to null', () => {
      const tasks = [makeTask({ id: 'T001' })];
      planEditorStore.setTasks(tasks);
      planEditorStore.setSaveError('some error');
      planEditorStore.markSaved();
      expect(planEditorStore.get().dirty).toBe(false);
      expect(planEditorStore.get().saveError).toBeNull();
    });
  });

  describe('__testReset', () => {
    it('returns store to initial state', () => {
      const tasks = [makeTask({ id: 'T001' })];
      planEditorStore.initEditor(tasks);
      planEditorStore.moveCursor('down');
      planEditorStore.toggleExpand('T001');
      planEditorStore.setRuntimeRichMode(true);
      planEditorStore.setSaveError('err');
      planEditorStore.__testReset();
      expect(planEditorStore.get()).toMatchObject({
        tasks: [],
        cursor: 0,
        dirty: false,
        runtimeRichMode: false,
        saveError: null,
      });
      expect(planEditorStore.get().expandedIds.size).toBe(0);
    });
  });
});
