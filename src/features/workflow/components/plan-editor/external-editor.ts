import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTasks } from '../../../../engine/spec/parser.js';
import { formatTasks } from '../../../../engine/spec/formatter.js';
import { planEditorStore } from '../../../../stores/workflow/plan-editor.js';
import { toErrorMessage } from '../../../../utils/format-errors.js';
import type { Task } from '../../../../core/schemas/task.js';
import { resolveEditorCommand } from '../../editor-command.js';
import { renumberTasks, parseSplitResult } from './actions.js';

const SPLIT_INSTRUCTION = '# Edit the task below. Use --- to split into multiple tasks.';

function removeTempFile(tmpPath: string): void {
  try {
    rmSync(tmpPath, { force: true });
  } catch {}
}

export function openExternalEditor(opts: {
  task: Task;
  mode: 'edit' | 'split';
  sessionDirPath: string;
}): void {
  const { task, mode, sessionDirPath } = opts;
  const editor = resolveEditorCommand();
  const prefix = mode === 'split' ? 'split' : 'edit';
  const tmpPath = join(sessionDirPath, `${prefix}-${task.id}.md`);

  const { tasks } = planEditorStore.get();
  const cursor = tasks.findIndex((t) => t.id === task.id);

  let content: string;
  if (mode === 'split') {
    const taskBlock = formatTasks([task]);
    content = `${SPLIT_INSTRUCTION}\n${taskBlock}`;
  } else {
    content = formatTasks([task]);
  }

  try {
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    planEditorStore.setSaveError(`Failed to write editor file: ${toErrorMessage(err)}`);
    return;
  }

  let result: ReturnType<typeof spawnSync>;
  try {
    process.stdin.pause();
    result = spawnSync(editor, [tmpPath], { stdio: 'inherit' });
  } catch (err) {
    planEditorStore.setSaveError(`Failed to open editor: ${toErrorMessage(err)}`);
    removeTempFile(tmpPath);
    return;
  } finally {
    process.stdin.resume();
  }

  if (result.error) {
    planEditorStore.setSaveError(
      `Failed to open editor: ${result.error.message || 'Set $EDITOR.'}`,
    );
    removeTempFile(tmpPath);
    return;
  }
  if (result.status !== 0) {
    const exit = result.signal ? `signal ${result.signal}` : `status ${result.status ?? 'unknown'}`;
    planEditorStore.setSaveError(`Editor exited with ${exit}. Edit cancelled.`);
    removeTempFile(tmpPath);
    return;
  }

  let editedContent: string;
  try {
    editedContent = readFileSync(tmpPath, 'utf-8');
  } catch (err) {
    planEditorStore.setSaveError(`Failed to read editor file: ${toErrorMessage(err)}`);
    removeTempFile(tmpPath);
    return;
  }

  removeTempFile(tmpPath);

  if (mode === 'edit') {
    let parsed: Task[];
    try {
      parsed = parseTasks(editedContent);
    } catch (err) {
      planEditorStore.setSaveError(`Edit parse failed: ${toErrorMessage(err)}`);
      return;
    }
    if (parsed.length !== 1) {
      planEditorStore.setSaveError(
        'Edit mode expects exactly 1 task. Use split mode (s) for multiple tasks.',
      );
      return;
    }
    if (cursor < 0) return;
    const first = parsed[0];
    if (!first) return;
    const updated = [...tasks];
    updated[cursor] = { ...first, status: 'pending' as const };
    const renumbered = renumberTasks(updated);
    planEditorStore.setTasks(renumbered);
  } else {
    const splitResult = parseSplitResult(editedContent);
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
