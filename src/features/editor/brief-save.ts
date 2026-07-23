import { isDeepStrictEqual } from 'node:util';
import type { Task } from '../../core/schemas/task.js';
import { topoSort } from '../../core/state/topo-sort.js';
import { evaluateBriefQuality, firstBriefError } from '../../engine/spec/brief-quality.js';
import { formatTasks } from '../../engine/spec/formatter.js';
import { parseTasksStrict } from '../../engine/spec/tasks/parse.js';

export function checkBriefSave(next: Task[]): { ok: true } | { ok: false; message: string } {
  if (next.length < 1) {
    return { ok: false, message: 'Cannot save an empty task list.' };
  }

  let roundTripped: Task[];
  try {
    roundTripped = parseTasksStrict(formatTasks(next));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!isDeepStrictEqual(roundTripped, next)) {
    return {
      ok: false,
      message: 'Edit cannot be saved without losing data (round-trip mismatch).',
    };
  }

  const firstError = firstBriefError(evaluateBriefQuality(next));
  if (firstError !== undefined) {
    return { ok: false, message: firstError.message };
  }

  try {
    topoSort(next);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true };
}
