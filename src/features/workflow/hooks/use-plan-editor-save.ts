import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TASKS_FILE, BRIEF_QUALITY_FILE } from '../../../core/paths.js';
import { formatTasks } from '../../../engine/spec/formatter.js';
import { parseTasks } from '../../../engine/spec/parser.js';
import { evaluateBriefQuality } from '../../../engine/spec/brief-quality.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';

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

    const parsed = parseTasks(markdown);
    const idMatch =
      parsed.length === tasks.length &&
      parsed.every((t, i) => t.id === tasks[i]?.id);

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
