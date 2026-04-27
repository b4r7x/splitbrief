import { beforeEach, describe, it, expect } from 'vitest';
import { applyPlanEditorAction, handlePlanEditorInput } from './use-plan-editor-keys.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { Key } from 'ink';

const noKey: Key = {
  ctrl: false,
  meta: false,
  shift: false,
  return: false,
  escape: false,
  tab: false,
  backspace: false,
  delete: false,
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

describe('handlePlanEditorInput', () => {
  it("'j' → move-cursor down", () => {
    expect(handlePlanEditorInput('j', noKey)).toEqual({ type: 'move-cursor', direction: 'down' });
  });

  it("'k' → move-cursor up", () => {
    expect(handlePlanEditorInput('k', noKey)).toEqual({ type: 'move-cursor', direction: 'up' });
  });

  it('downArrow → move-cursor down', () => {
    expect(handlePlanEditorInput('', { ...noKey, downArrow: true })).toEqual({ type: 'move-cursor', direction: 'down' });
  });

  it('upArrow → move-cursor up', () => {
    expect(handlePlanEditorInput('', { ...noKey, upArrow: true })).toEqual({ type: 'move-cursor', direction: 'up' });
  });

  it('ctrl+j → move-task down', () => {
    expect(handlePlanEditorInput('j', { ...noKey, ctrl: true })).toEqual({ type: 'move-task', direction: 'down' });
  });

  it('ctrl+k → move-task up', () => {
    expect(handlePlanEditorInput('k', { ...noKey, ctrl: true })).toEqual({ type: 'move-task', direction: 'up' });
  });

  it('ctrl+n → move-task down', () => {
    expect(handlePlanEditorInput('n', { ...noKey, ctrl: true })).toEqual({ type: 'move-task', direction: 'down' });
  });

  it('ctrl+p → move-task up', () => {
    expect(handlePlanEditorInput('p', { ...noKey, ctrl: true })).toEqual({ type: 'move-task', direction: 'up' });
  });

  it("'d' → delete-task", () => {
    expect(handlePlanEditorInput('d', noKey)).toEqual({ type: 'delete-task' });
  });

  it("'m' → merge-task", () => {
    expect(handlePlanEditorInput('m', noKey)).toEqual({ type: 'merge-task' });
  });

  it("'s' → open-editor split", () => {
    expect(handlePlanEditorInput('s', noKey)).toEqual({ type: 'open-editor', mode: 'split' });
  });

  it("'e' → open-editor edit", () => {
    expect(handlePlanEditorInput('e', noKey)).toEqual({ type: 'open-editor', mode: 'edit' });
  });

  it('return → toggle-expand', () => {
    expect(handlePlanEditorInput('', { ...noKey, return: true })).toEqual({ type: 'toggle-expand' });
  });

  it("'?' → open-help", () => {
    expect(handlePlanEditorInput('?', noKey)).toEqual({ type: 'open-help' });
  });

  it("'Y' (capital) → save", () => {
    expect(handlePlanEditorInput('Y', noKey)).toEqual({ type: 'save' });
  });

  it("'y' (lowercase) → none", () => {
    expect(handlePlanEditorInput('y', noKey)).toEqual({ type: 'none' });
  });

  it("'q' → discard", () => {
    expect(handlePlanEditorInput('q', noKey)).toEqual({ type: 'discard' });
  });

  it('unrecognized input → none', () => {
    expect(handlePlanEditorInput('x', noKey)).toEqual({ type: 'none' });
    expect(handlePlanEditorInput('', noKey)).toEqual({ type: 'none' });
  });
});

describe('applyPlanEditorAction', () => {
  beforeEach(() => planEditorStore.__testReset());

  it("'q' discards runtime rich mode edits back to the simple-view baseline", () => {
    const task = makeTask({ id: 'T001' });
    planEditorStore.setRuntimeRichMode(true);
    planEditorStore.initEditor([task]);
    planEditorStore.setTasks([{ ...task, title: 'Edited title' }]);
    planEditorStore.setSaveError('unsaved');

    applyPlanEditorAction({ type: 'discard' }, () => Promise.resolve());

    expect(planEditorStore.get()).toMatchObject({
      tasks: [],
      cursor: 0,
      dirty: false,
      runtimeRichMode: false,
      saveError: null,
    });
  });
});
