import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TASKS_FILE, BRIEF_QUALITY_FILE } from '../../../core/paths.js';
import { formatTasks } from '../../../engine/spec/formatter.js';
import { parseTasks } from '../../../engine/spec/parser.js';
import { evaluateBriefQuality } from '../../../engine/spec/brief-quality.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import type { Task } from '../../../core/schemas/task.js';

function sameTaskIds(a: Task[], b: Task[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map(task => task.id));
  if (ids.size !== a.length) return false;
  if (new Set(b.map(task => task.id)).size !== b.length) return false;
  for (const task of b) {
    if (!ids.has(task.id)) return false;
  }
  return true;
}

export function createSaveHandler(sessionDirPath: string, onApprove?: () => void): () => Promise<void> {
  return async () => {
    const { tasks } = planEditorStore.get();
    const tasksPath = join(sessionDirPath, TASKS_FILE);
    const tmpPath = `${tasksPath}.tmp`;

    const markdown = formatTasks(tasks);

    try {
      await writeFile(tmpPath, markdown, { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      planEditorStore.setSaveError(`Failed to write: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let parsed: Task[];
    try {
      parsed = parseTasks(markdown);
    } catch (err) {
      try { await rename(tmpPath, tmpPath + '.bad'); } catch { /* ignore */ }
      planEditorStore.setSaveError(`Round-trip parse failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const idMatch = sameTaskIds(parsed, tasks);

    if (!idMatch) {
      try { await rename(tmpPath, tmpPath + '.bad'); } catch { /* ignore */ }
      planEditorStore.setSaveError('Round-trip validation failed. Tasks not saved.');
      return;
    }

    try {
      await rename(tmpPath, tasksPath);
    } catch (err) {
      planEditorStore.setSaveError(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const report = evaluateBriefQuality(tasks);
    const qualityPath = join(sessionDirPath, BRIEF_QUALITY_FILE);
    try {
      await writeFile(qualityPath, JSON.stringify(report, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch {
      // non-fatal: brief-quality.json write failure doesn't block the approval
    }

    planEditorStore.markSaved();
    onApprove?.();
  };
}
