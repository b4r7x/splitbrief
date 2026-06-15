import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTaskBlocksStrict } from '../../../engine/spec/parser.js';
import { formatTasks } from '../../../engine/spec/formatter.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import type { Task } from '../../../core/schemas/task.js';
import { assertSessionConfinement } from '../../../core/sessions/confinement.js';
import { resolveEditorArgv } from '../editor-command.js';
import { renumberTasks } from './actions.js';
import { topoSort } from '../../../core/state/topo-sort.js';
import {
  resumeTerminalAfterEditor,
  suspendTerminalForEditor,
} from '../../../lib/terminal/editor-handover.js';

const SPLIT_INSTRUCTION =
  '# Edit the task below. Use --- to split into multiple tasks. Each new task needs its own `--- id/title/action/file ---` frontmatter block.';

function removeTempFile(tmpPath: string): void {
  try {
    rmSync(tmpPath, { force: true });
  } catch {}
}

function pathExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function assertExistingSessionPath(filePath: string, sessionDirPath: string): void {
  if (!pathExists(sessionDirPath)) return;
  assertSessionConfinement(filePath, sessionDirPath);
}

function pickPreservePath(tmpPath: string, sessionDirPath: string): string | null {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const badPath = attempt === 0 ? `${tmpPath}.bad` : `${tmpPath}.bad.${attempt}`;
    const st = lstatSync(badPath, { throwIfNoEntry: false });
    if (st !== undefined) continue;
    try {
      assertExistingSessionPath(badPath, sessionDirPath);
      return badPath;
    } catch {
      return null;
    }
  }
  return null;
}

function preserveFailedEdit(
  tmpPath: string,
  sessionDirPath: string,
  editedContent: string,
): string {
  const badPath = pickPreservePath(tmpPath, sessionDirPath);
  if (badPath === null) return tmpPath;
  try {
    writeFileSync(badPath, editedContent, { encoding: 'utf-8', mode: 0o600 });
    return badPath;
  } catch {
    try {
      renameSync(tmpPath, badPath);
      return badPath;
    } catch {
      return tmpPath;
    }
  }
}

function mergeEditedTasks(fullTasks: Task[], cursor: number, edited: Task[]): Task[] {
  if (cursor < 0) return fullTasks;
  const before = fullTasks.slice(0, cursor);
  const after = fullTasks.slice(cursor + 1);
  return topoSort([...before, ...edited, ...after]);
}

export function openExternalEditor(opts: {
  task: Task;
  mode: 'edit' | 'split';
  sessionDirPath: string;
}): void {
  const { task, mode, sessionDirPath } = opts;
  const { command, args } = resolveEditorArgv();
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
    if (lstatSync(tmpPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      planEditorStore.setSaveError('Refusing to write editor file through symlink');
      return;
    }
    assertExistingSessionPath(tmpPath, sessionDirPath);
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    planEditorStore.setSaveError(`Failed to write editor file: ${toErrorMessage(err)}`);
    return;
  }

  let result: ReturnType<typeof spawnSync>;
  try {
    suspendTerminalForEditor();
    result = spawnSync(command, [...args, tmpPath], { stdio: 'inherit' });
  } catch (err) {
    planEditorStore.setSaveError(`Failed to open editor: ${toErrorMessage(err)}`);
    removeTempFile(tmpPath);
    return;
  } finally {
    resumeTerminalAfterEditor();
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

  if (mode === 'edit') {
    let parsed: Task[];
    try {
      parsed = parseTaskBlocksStrict(editedContent);
    } catch (err) {
      const badPath = preserveFailedEdit(tmpPath, sessionDirPath, editedContent);
      planEditorStore.setSaveError(
        `Edit parse failed: ${toErrorMessage(err)} (preserved at ${badPath})`,
      );
      return;
    }
    if (parsed.length !== 1) {
      const badPath = preserveFailedEdit(tmpPath, sessionDirPath, editedContent);
      planEditorStore.setSaveError(
        `Edit mode expects exactly 1 task. Use split mode (s) for multiple tasks. (preserved at ${badPath})`,
      );
      return;
    }
    try {
      const merged = mergeEditedTasks(tasks, cursor, parsed);
      const renumbered = renumberTasks(merged);
      removeTempFile(tmpPath);
      planEditorStore.setTasks(renumbered);
    } catch (err) {
      const badPath = preserveFailedEdit(tmpPath, sessionDirPath, editedContent);
      planEditorStore.setSaveError(
        `Edit validation failed: ${toErrorMessage(err)} (preserved at ${badPath})`,
      );
    }
    return;
  }

  let splitTasks: Task[];
  try {
    splitTasks = parseTaskBlocksStrict(editedContent);
  } catch (err) {
    const badPath = preserveFailedEdit(tmpPath, sessionDirPath, editedContent);
    planEditorStore.setSaveError(
      `split parse failed: ${toErrorMessage(err)} (preserved at ${badPath})`,
    );
    return;
  }
  if (splitTasks.length === 0) {
    const badPath = preserveFailedEdit(tmpPath, sessionDirPath, editedContent);
    planEditorStore.setSaveError(`split produced no tasks (preserved at ${badPath})`);
    return;
  }
  try {
    const merged = mergeEditedTasks(tasks, cursor, splitTasks);
    const renumbered = renumberTasks(merged);
    removeTempFile(tmpPath);
    planEditorStore.setTasks(renumbered);
  } catch (err) {
    const badPath = preserveFailedEdit(tmpPath, sessionDirPath, editedContent);
    planEditorStore.setSaveError(
      `split validation failed: ${toErrorMessage(err)} (preserved at ${badPath})`,
    );
  }
}
