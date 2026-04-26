import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTasks } from '../../../../engine/spec/parser.js';
import { formatTasks } from '../../../../engine/spec/formatter.js';
import { planEditorStore } from '../../../../stores/workflow/plan-editor.js';
import type { Task } from '../../../../core/schemas/task.js';
import { renumberTasks, parseSplitResult } from './actions.js';

const SPLIT_INSTRUCTION = '# Edit the task below. Use --- to split into multiple tasks.';

export function openExternalEditor(task: Task, mode: 'edit' | 'split', sessionDirPath: string): void {
  const editor = process.env.EDITOR ?? 'vi';
  const prefix = mode === 'split' ? 'split' : 'edit';
  const tmpPath = join(sessionDirPath, `${prefix}-${task.id}.md`);

  const { tasks } = planEditorStore.get();
  const cursor = tasks.findIndex(t => t.id === task.id);

  let content: string;
  if (mode === 'split') {
    const taskBlock = formatTasks([task]);
    content = `${SPLIT_INSTRUCTION}\n${taskBlock}`;
  } else {
    content = formatTasks([task]);
  }

  writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });

  process.stdin.pause();
  const result = spawnSync(editor, [tmpPath], { stdio: 'inherit' });
  process.stdin.resume();

  if (result.error) {
    planEditorStore.setSaveError('Editor not found. Set $EDITOR.');
    rmSync(tmpPath, { force: true });
    return;
  }

  let editedContent: string;
  try {
    editedContent = readFileSync(tmpPath, 'utf-8');
  } catch {
    rmSync(tmpPath, { force: true });
    return;
  }

  rmSync(tmpPath, { force: true });

  if (mode === 'edit') {
    const parsed = parseTasks(editedContent);
    if (parsed.length !== 1) {
      planEditorStore.setSaveError('Edit mode expects exactly 1 task. Use split mode (s) for multiple tasks.');
      return;
    }
    if (cursor < 0) return;
    const updated = [...tasks];
    updated[cursor] = { ...parsed[0]!, status: 'pending' as const };
    const renumbered = renumberTasks(updated);
    planEditorStore.setTasks(renumbered);
  } else {
    const splitResult = parseSplitResult(editedContent, task);
    if ('error' in splitResult) {
      planEditorStore.setSaveError(splitResult.error);
      return;
    }
    if (cursor < 0) return;
    const before = tasks.slice(0, cursor);
    const after = tasks.slice(cursor + 1);
    const merged = [...before, ...splitResult, ...after];
    const renumbered = renumberTasks(merged);
    planEditorStore.setTasks(renumbered);
  }
}
