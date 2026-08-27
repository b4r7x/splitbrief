import { dirname } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { EventBus } from '../../events/types.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import { readSessionFileConfined } from '../../../core/sessions/confinement.js';
import { parseTasksStrict } from '../../spec/tasks/parse.js';
import { labelError } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';
import { writeAndPublishArtifacts, type ArtifactKind } from '../artifact-write.js';
import type { PlanResult } from '../../planners/types.js';
import type { BriefGenerationRef, TaskExecutionPermit } from '../../../core/schemas/brief-owner.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { readWorkflowStateHead } from '../state-ops.js';

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
  /** Committed generation receipt required by fixed Tasks projections. */
  generation?: BriefGenerationRef | undefined;
}): void {
  const { projectDir, sessionId, metadata, bus, phase, generation } = opts;
  const items = (opts.phases ?? []).map((phaseResult) => ({
    kind: artifactKindFor(phaseResult.artifact.logicalName),
    text: phaseResult.artifact.text,
    ...(phaseResult.artifact.logicalName === SPEC_FILE ||
    phaseResult.artifact.logicalName === PLAN_FILE
      ? { admission: 'already-admitted' as const }
      : {}),
  }));
  writeAndPublishArtifacts({ projectDir, sessionId, bus, phase, metadata, items, generation });
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

export type OwnerReadiness =
  | Readonly<{
      ok: true;
      authorityRevision: number;
      generation: BriefGenerationRef;
      permit: TaskExecutionPermit;
    }>
  | Readonly<{
      ok: false;
      reason: 'no-state' | 'no-recovery' | 'not-ready' | 'no-generation' | 'no-permit';
    }>;

/**
 * Contract readiness resolves the owner-committed authority, never the fixed
 * `tasks.md` projection or a provider-returned candidate. The persisted head
 * schema already binds a current permit to the current generation, authority
 * revision, recovery epoch, and ready recovery status.
 */
export function resolveOwnerReadiness(ref: SessionRef): OwnerReadiness {
  const head = readWorkflowStateHead(ref);
  if (head === null) return { ok: false, reason: 'no-state' };
  const recovery = head.state.briefRecovery;
  if (recovery === null || recovery === undefined) return { ok: false, reason: 'no-recovery' };
  if (recovery.status !== 'ready') return { ok: false, reason: 'not-ready' };
  if (head.state.generation === undefined || head.state.generation === null) {
    return { ok: false, reason: 'no-generation' };
  }
  if (head.state.permit === undefined || head.state.permit === null) {
    return { ok: false, reason: 'no-permit' };
  }
  return {
    ok: true,
    authorityRevision: head.state.authorityRevision ?? 0,
    generation: head.state.generation,
    permit: head.state.permit,
  };
}
