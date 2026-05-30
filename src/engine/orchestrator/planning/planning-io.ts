import { readFile } from 'node:fs/promises';
import type { Task } from '../../../core/schemas/task.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { formatTasks } from '../../spec/formatter.js';
import { parseTasks } from '../../spec/parser.js';
import { labelError } from '../../../utils/format-errors.js';
import { isENOENT } from '../../../lib/process/errors.js';
import type { PlanResult } from '../../planners/types.js';

export function persistPhases(
  projectDir: string,
  sessionId: string,
  phases: PlanResult['phases'],
  metadata: SpecMetadata,
): void {
  for (const phase of phases ?? []) {
    writeSpecFile({ projectDir, sessionId }, phase.filename, phase.text, metadata);
  }
}

export type PersistedTasksResult =
  | { ok: true; tasks: Task[] }
  | { ok: false; reason: 'missing' | 'unreadable' | 'parse' | 'empty'; message: string };

export async function readPersistedTasks(tasksFilePath: string): Promise<PersistedTasksResult> {
  let text: string;
  try {
    text = await readFile(tasksFilePath, 'utf8');
  } catch (err) {
    if (isENOENT(err)) {
      return {
        ok: false,
        reason: 'missing',
        message: `Task Brief file is missing: ${tasksFilePath}`,
      };
    }
    return {
      ok: false,
      reason: 'unreadable',
      message: labelError('Failed to read Task Brief file', err),
    };
  }

  if (text.trim() === '') {
    return { ok: false, reason: 'empty', message: `Task Brief file is empty: ${tasksFilePath}` };
  }

  try {
    const parsed = parseTasks(text);
    if (parsed.length === 0) {
      return {
        ok: false,
        reason: 'empty',
        message: `Task Brief file has no parseable tasks: ${tasksFilePath}`,
      };
    }
    return { ok: true, tasks: parsed };
  } catch (err) {
    return {
      ok: false,
      reason: 'parse',
      message: labelError('Failed to parse Task Brief file', err),
    };
  }
}

export async function readTasksForApproval(
  tasksFilePath: string,
  currentTasks: Task[],
  projectDir: string,
  sessionId: string,
  metadata: SpecMetadata,
): Promise<PersistedTasksResult> {
  const first = await readPersistedTasks(tasksFilePath);
  if (first.ok || first.reason !== 'missing') return first;
  if (currentTasks.length === 0) return first;
  writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks(currentTasks), metadata);
  return readPersistedTasks(tasksFilePath);
}
