import { dirname } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { EventBus } from '../../events/types.js';
import { writeSpecFile, type SpecMetadata } from '../../../core/paths-io.js';
import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import { readSessionFileConfined } from '../../../core/sessions/confinement.js';
import { parseTasksStrict } from '../../spec/tasks/parse.js';
import { formatTasks } from '../../spec/formatter.js';
import { labelError } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';
import { writeAndPublishArtifacts, type ArtifactKind } from '../artifact-write.js';
import type { PlanResult } from '../../planners/types.js';

function artifactKindFor(filename: string): ArtifactKind {
  switch (filename) {
    case RESEARCH_FILE:
      return 'research';
    case SPEC_FILE:
      return 'spec';
    case PLAN_FILE:
      return 'plan';
    case TASKS_FILE:
      return 'task-briefs';
    default:
      throw error('planning-unknown-artifact', `Unsupported planning phase artifact: ${filename}`, {
        filename,
      });
  }
}

export function persistPhases(opts: {
  projectDir: string;
  sessionId: string;
  phases: PlanResult['phases'];
  metadata: SpecMetadata;
  bus: EventBus;
  phase: Phase;
}): void {
  const { projectDir, sessionId, metadata, bus, phase } = opts;
  const items = (opts.phases ?? []).map((phaseResult) => ({
    kind: artifactKindFor(phaseResult.artifact.logicalName),
    text: phaseResult.artifact.text,
    ...(phaseResult.artifact.logicalName === SPEC_FILE ||
    phaseResult.artifact.logicalName === PLAN_FILE
      ? { admission: 'already-admitted' as const }
      : {}),
  }));
  writeAndPublishArtifacts({ projectDir, sessionId, bus, phase, metadata, items });
}

export type PersistedTasksResult =
  | { ok: true; tasks: Task[] }
  | { ok: false; reason: 'missing' | 'unreadable' | 'parse' | 'empty'; message: string };

type ConfinedReadResult = { ok: true; text: string } | { ok: false; reason: 'missing' };

async function readConfinedSessionText(filePath: string): Promise<ConfinedReadResult> {
  const sessionDirPath = dirname(filePath);
  const text = await readSessionFileConfined(sessionDirPath, filePath);
  return text === null ? { ok: false, reason: 'missing' } : { ok: true, text };
}

export async function readPersistedTasks(
  tasksFilePath: string,
  onWarning?: (message: string) => void,
): Promise<PersistedTasksResult> {
  let result: ConfinedReadResult;
  try {
    result = await readConfinedSessionText(tasksFilePath);
  } catch (err) {
    return {
      ok: false,
      reason: 'unreadable',
      message: labelError('Failed to read Task Brief file', err),
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      reason: 'missing',
      message: `Task Brief file is missing: ${tasksFilePath}`,
    };
  }

  const text = result.text;
  if (text.trim() === '') {
    return { ok: false, reason: 'empty', message: `Task Brief file is empty: ${tasksFilePath}` };
  }

  try {
    const parsed = parseTasksStrict(text, onWarning);
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

export async function readTasksForApproval(opts: {
  tasksFilePath: string;
  currentTasks: Task[];
  projectDir: string;
  sessionId: string;
  metadata: SpecMetadata;
  onWarning?: (message: string) => void;
}): Promise<PersistedTasksResult> {
  const { tasksFilePath, currentTasks, projectDir, sessionId, metadata, onWarning } = opts;
  const first = await readPersistedTasks(tasksFilePath, onWarning);
  if (first.ok || first.reason !== 'missing') return first;
  if (currentTasks.length === 0) return first;
  writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks(currentTasks), metadata);
  return readPersistedTasks(tasksFilePath, onWarning);
}
