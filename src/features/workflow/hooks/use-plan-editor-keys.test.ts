import { beforeEach, describe, it, expect } from 'vitest';
import {
  applyPlanEditorAction,
  handlePlanEditorInput,
  type PlanEditorAction,
} from './use-plan-editor-keys.js';
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
  beforeEach(() => planEditorStore.__testReset());

  it.each<{
    label: string;
    input: string;
    key?: Partial<Key>;
    expected: PlanEditorAction;
  }>([
    { label: 'j', input: 'j', expected: { type: 'move-cursor', direction: 'down' } },
    { label: 'k', input: 'k', expected: { type: 'move-cursor', direction: 'up' } },
    {
      label: 'downArrow',
      input: '',
      key: { downArrow: true },
      expected: { type: 'move-cursor', direction: 'down' },
    },
    {
      label: 'upArrow',
      input: '',
      key: { upArrow: true },
      expected: { type: 'move-cursor', direction: 'up' },
    },
    {
      label: 'ctrl+j',
      input: 'j',
      key: { ctrl: true },
      expected: { type: 'move-task', direction: 'down' },
    },
    {
      label: 'ctrl+k',
      input: 'k',
      key: { ctrl: true },
      expected: { type: 'move-task', direction: 'up' },
    },
    {
      label: 'ctrl+n',
      input: 'n',
      key: { ctrl: true },
      expected: { type: 'move-task', direction: 'down' },
    },
    {
      label: 'ctrl+p',
      input: 'p',
      key: { ctrl: true },
      expected: { type: 'move-task', direction: 'up' },
    },
    { label: 'd', input: 'd', expected: { type: 'delete-task' } },
    { label: 'm', input: 'm', expected: { type: 'merge-task' } },
    { label: 'p', input: 'p', expected: { type: 'toggle-packet-preview' } },
    { label: 's', input: 's', expected: { type: 'open-editor', mode: 'split' } },
    { label: 'E', input: 'E', expected: { type: 'open-editor', mode: 'edit' } },
    { label: 'c', input: 'c', expected: { type: 'copy-selection' } },
    { label: 'tab', input: '', key: { tab: true }, expected: { type: 'enter-section-list' } },
    { label: 'return', input: '', key: { return: true }, expected: { type: 'toggle-expand' } },
    { label: '?', input: '?', expected: { type: 'open-help' } },
    { label: 'Y', input: 'Y', expected: { type: 'save' } },
    { label: 'q', input: 'q', expected: { type: 'discard' } },
    { label: 'lowercase y', input: 'y', expected: { type: 'none' } },
    { label: 'x flags task', input: 'x', expected: { type: 'toggle-flag' } },
    { label: 'R regenerates flagged', input: 'R', expected: { type: 'regenerate-flagged' } },
    { label: 'unrecognized input', input: 'z', expected: { type: 'none' } },
    { label: 'empty input', input: '', expected: { type: 'none' } },
  ])('$label maps to $expected.type', ({ input, key, expected }) => {
    expect(handlePlanEditorInput(input, { ...noKey, ...key })).toEqual(expected);
  });

  it.each<{
    label: string;
    input: string;
    key?: Partial<Key>;
    expected: PlanEditorAction;
  }>([
    { label: 'j', input: 'j', expected: { type: 'move-section-cursor', direction: 'down' } },
    { label: 'k', input: 'k', expected: { type: 'move-section-cursor', direction: 'up' } },
    { label: 'e', input: 'e', expected: { type: 'start-section-edit' } },
    { label: 'c', input: 'c', expected: { type: 'copy-selection' } },
    { label: 'esc', input: '', key: { escape: true }, expected: { type: 'leave-section-list' } },
  ])('section-list $label maps to $expected.type', ({ input, key, expected }) => {
    planEditorStore.__testReset({ focus: 'section-list' });

    expect(handlePlanEditorInput(input, { ...noKey, ...key })).toEqual(expected);
  });

  it.each<{
    label: string;
    input: string;
    key?: Partial<Key>;
    expected: PlanEditorAction;
  }>([
    {
      label: 'ctrl+enter',
      input: '',
      key: { ctrl: true, return: true },
      expected: { type: 'save-section-edit' },
    },
    {
      label: 'esc',
      input: '',
      key: { escape: true },
      expected: { type: 'cancel-section-edit' },
    },
    { label: 'plain c', input: 'c', expected: { type: 'none' } },
  ])('editing-section $label maps to $expected.type', ({ input, key, expected }) => {
    planEditorStore.__testReset({
      focus: 'editing-section',
      editing: { taskId: 'T001', section: 'title', value: 'Draft' },
    });

    expect(handlePlanEditorInput(input, { ...noKey, ...key })).toEqual(expected);
  });
});

describe('applyPlanEditorAction', () => {
  beforeEach(() => planEditorStore.__testReset());

  it("'q' discards edits without emptying the rich editor store", () => {
    const task = makeTask({ id: 'T001', title: 'Original title' });
    planEditorStore.setRuntimeRichMode(true);
    planEditorStore.initEditor([task]);
    planEditorStore.setTasks([{ ...task, title: 'Edited title' }]);
    planEditorStore.setSaveError('unsaved');

    applyPlanEditorAction({ type: 'discard' }, () => Promise.resolve());

    expect(planEditorStore.get()).toMatchObject({
      tasks: [task],
      cursor: 0,
      dirty: false,
      runtimeRichMode: false,
      saveError: null,
    });
  });

  it('boundary move does not mark the editor dirty', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    planEditorStore.initEditor(tasks);
    planEditorStore.setCursor(1);

    applyPlanEditorAction({ type: 'move-task', direction: 'down' }, () => Promise.resolve());

    expect(planEditorStore.get().dirty).toBe(false);
    expect(planEditorStore.get().tasks).toEqual(tasks);
  });

  it('out-of-range delete does not mark the editor dirty or clamp cursor as a side effect', () => {
    const tasks = [makeTask({ id: 'T001' })];
    planEditorStore.__testReset({ tasks, cursor: 5 });

    applyPlanEditorAction({ type: 'delete-task' }, () => Promise.resolve());

    expect(planEditorStore.get().dirty).toBe(false);
    expect(planEditorStore.get().cursor).toBe(5);
    expect(planEditorStore.get().tasks).toEqual(tasks);
  });

  it('applies section focus and edit actions through the store', () => {
    const task = makeTask({ id: 'T001', title: 'Original title' });
    planEditorStore.initEditor([task]);

    applyPlanEditorAction({ type: 'enter-section-list' }, () => Promise.resolve());
    applyPlanEditorAction({ type: 'start-section-edit' }, () => Promise.resolve());
    planEditorStore.updateEditingValue('Edited title');
    applyPlanEditorAction({ type: 'save-section-edit' }, () => Promise.resolve());

    expect(planEditorStore.get()).toMatchObject({
      focus: 'section-list',
      dirty: true,
    });
    expect(planEditorStore.get().tasks[0]?.title).toBe('Edited title');
  });
});
