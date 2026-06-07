import { rename, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS_FILE, BRIEF_QUALITY_FILE } from '../../core/paths.js';
import { formatTasks } from '../../engine/spec/formatter.js';
import { parseTasksStrict } from '../../engine/spec/parser.js';
import { evaluateBriefQuality, firstBriefErrorMessage } from '../../engine/spec/brief-quality.js';
import { assertSessionConfinement } from '../../engine/ipc/lockfile.js';
import {
  PLAN_EDITOR_STALE_SAVE_ERROR,
  planEditorStore,
} from '../../stores/workflow/plan-editor.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import type { Task } from '../../core/schemas/task.js';

interface SaveHandlerDeps {
  rename: typeof rename;
  writeFile: typeof writeFile;
}

const defaultDeps: SaveHandlerDeps = { rename, writeFile };

function pathExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function assertExistingSessionPath(filePath: string, sessionDirPath: string): void {
  if (!pathExists(sessionDirPath)) return;
  assertSessionConfinement(filePath, sessionDirPath);
}

function sameTaskIds(a: Task[], b: Task[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((task) => task.id));
  if (ids.size !== a.length) return false;
  if (new Set(b.map((task) => task.id)).size !== b.length) return false;
  for (const task of b) {
    if (!ids.has(task.id)) return false;
  }
  return true;
}

async function quarantineTemp(deps: SaveHandlerDeps, tmpPath: string): Promise<void> {
  try {
    await deps.rename(tmpPath, `${tmpPath}.bad`);
  } catch {
    /* ignore */
  }
}

async function writeBriefQualityReport(
  deps: SaveHandlerDeps,
  sessionDirPath: string,
  report: ReturnType<typeof evaluateBriefQuality>,
): Promise<void> {
  const qualityPath = join(sessionDirPath, BRIEF_QUALITY_FILE);
  try {
    assertExistingSessionPath(qualityPath, sessionDirPath);
    if (lstatSync(qualityPath, { throwIfNoEntry: false })?.isSymbolicLink()) return;
    await deps.writeFile(qualityPath, JSON.stringify(report, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    /* ignore */
  }
}

export function createSaveHandler(
  sessionDirPath: string,
  onApprove?: () => void,
  deps: SaveHandlerDeps = defaultDeps,
): () => Promise<void> {
  return async () => {
    const { tasks, revision } = planEditorStore.get();
    const tasksPath = join(sessionDirPath, TASKS_FILE);
    const tmpPath = `${tasksPath}.tmp`;

    const markdown = formatTasks(tasks);

    if (lstatSync(tmpPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      planEditorStore.setSaveError('Refusing to write through symlink');
      return;
    }

    try {
      assertExistingSessionPath(tasksPath, sessionDirPath);
      assertExistingSessionPath(tmpPath, sessionDirPath);
    } catch {
      planEditorStore.setSaveError('Refusing to write outside the session directory');
      return;
    }

    try {
      await deps.writeFile(tmpPath, markdown, { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      planEditorStore.setSaveError(`Failed to write: ${toErrorMessage(err)}`);
      return;
    }

    let parsed: Task[];
    try {
      parsed = parseTasksStrict(markdown);
    } catch (err) {
      await quarantineTemp(deps, tmpPath);
      planEditorStore.setSaveError(`Round-trip parse failed: ${toErrorMessage(err)}`);
      return;
    }

    const idMatch = sameTaskIds(parsed, tasks);

    if (!idMatch) {
      await quarantineTemp(deps, tmpPath);
      planEditorStore.setSaveError('Round-trip validation failed. Tasks not saved.');
      return;
    }

    const report = evaluateBriefQuality(tasks);
    if (!report.passed) {
      await quarantineTemp(deps, tmpPath);
      planEditorStore.setSaveError(`Brief quality failed: ${firstBriefErrorMessage(report)}`);
      return;
    }

    if (planEditorStore.get().revision !== revision) {
      await quarantineTemp(deps, tmpPath);
      planEditorStore.setSaveError(PLAN_EDITOR_STALE_SAVE_ERROR);
      return;
    }

    try {
      assertExistingSessionPath(tasksPath, sessionDirPath);
      assertExistingSessionPath(tmpPath, sessionDirPath);
      await deps.rename(tmpPath, tasksPath);
    } catch (err) {
      planEditorStore.setSaveError(`Failed to save: ${toErrorMessage(err)}`);
      return;
    }

    if (!planEditorStore.markSavedIfRevision(revision)) return;
    await writeBriefQualityReport(deps, sessionDirPath, report);
    onApprove?.();
  };
}
