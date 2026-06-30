import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import type { z } from 'zod';
import type { RecoveryFact } from '../schemas/recovery.js';
import type { WorkflowState } from '../schemas/workflow.js';
import {
  SessionLogEntrySchema,
  SessionLogEventEntrySchema,
  SESSION_LOG_MAX_ENTRY_BYTES,
  type SessionLogEventEntry,
  type SessionLogMessageEntry,
} from '../schemas/session-log.js';
import { PhaseSchema } from '../schemas/enums.js';
import { TaskIdSchema } from '../schemas/task.js';
import { WorkflowStateSchema } from '../schemas/workflow.js';
import { CURRENT_STATE_VERSION } from './machine.js';
import { normalizeLoadedWorkflowState } from '../queue-state.js';
import type { SessionRef } from '../types/session-ref.js';
import {
  DIPTYCH_DIR,
  SESSIONS_DIR,
  STATE_FILE,
  SESSION_LOG_FILE,
  sessionDir,
  validateSessionId,
} from '../paths.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { fsError, rejectSymlinkTarget } from '../../lib/fs.js';
import {
  confinedAppendFileSync,
  confinedEnsureDir,
  confinedWriteFile,
} from '../../lib/confined-fs.js';
import {
  assertExistingPathConfined,
  assertPathConfined,
  isInsideRoot,
  nearestExistingAncestor,
  pathConfinementError,
} from '../../lib/path-confinement.js';
import { warnStderr } from '../../lib/warn.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { nowIso } from '../../utils/format-time.js';
import { protectConsumerPayload } from '../consumer-policy.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../transcript-policy.js';
import { stripTerminalControls } from '../../utils/display-text.js';

export function consoleWorkflowFeature(opts: {
  feature: string;
  persistTranscript: boolean;
}): string {
  const feature = opts.persistTranscript ? opts.feature : TRANSCRIPT_OMITTED_MESSAGE;
  return stripTerminalControls(feature);
}

export function projectWorkflowStateForTranscriptPolicy(
  state: WorkflowState,
  opts: { persistTranscript: boolean },
): WorkflowState {
  if (opts.persistTranscript) return state;
  const {
    changedFilesBaseline: _changedFilesBaseline,
    external: _external,
    pendingRecovery,
    plannerSessionId,
    rewindPending,
    ...base
  } = state;

  return {
    ...base,
    feature: TRANSCRIPT_OMITTED_MESSAGE,
    ...(plannerSessionId !== undefined && {
      plannerSessionId: plannerSessionId === null ? null : TRANSCRIPT_OMITTED_MESSAGE,
    }),
    tasks: state.tasks.map(projectTaskForTranscriptPolicy),
    messageQueue: state.messageQueue.map(projectQueuedMessageForTranscriptPolicy),
    ...(pendingRecovery !== undefined && {
      pendingRecovery: {
        ...pendingRecovery,
        ...(pendingRecovery.taskTitle !== undefined && {
          taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
        }),
        files: pendingRecovery.files.map(omittedText),
        message: TRANSCRIPT_OMITTED_MESSAGE,
        details: pendingRecovery.details.map(omittedText),
        ...(pendingRecovery.facts !== undefined && {
          facts: projectRecoveryFactsForTranscriptPolicy(pendingRecovery.facts),
        }),
      },
    }),
    ...(rewindPending !== undefined && {
      rewindPending: {
        ...rewindPending,
        ...(rewindPending.comment !== undefined && { comment: TRANSCRIPT_OMITTED_MESSAGE }),
      },
    }),
  };
}

type WorkflowTask = WorkflowState['tasks'][number];
type WorkflowQueuedMessage = WorkflowState['messageQueue'][number];

function projectTaskForTranscriptPolicy(task: WorkflowTask): WorkflowTask {
  return {
    ...task,
    title: TRANSCRIPT_OMITTED_MESSAGE,
    file: TRANSCRIPT_OMITTED_MESSAGE,
    description: TRANSCRIPT_OMITTED_MESSAGE,
    ...(task.signature !== undefined && { signature: TRANSCRIPT_OMITTED_MESSAGE }),
    ...(task.currentCode !== undefined && { currentCode: TRANSCRIPT_OMITTED_MESSAGE }),
    tests: task.tests.map(omittedText),
    constraints: task.constraints.map(omittedText),
    ...(task.pattern !== undefined && { pattern: TRANSCRIPT_OMITTED_MESSAGE }),
    typeDefs: TRANSCRIPT_OMITTED_MESSAGE,
    implementationSteps: task.implementationSteps.map(omittedText),
    ...(task.scope !== undefined && {
      scope: {
        ...(task.scope.inBounds !== undefined && {
          inBounds: task.scope.inBounds.map(omittedText),
        }),
        ...(task.scope.outOfBounds !== undefined && {
          outOfBounds: task.scope.outOfBounds.map(omittedText),
        }),
        ...(task.scope.approvedOutOfBounds !== undefined && {
          approvedOutOfBounds: task.scope.approvedOutOfBounds.map(omittedText),
        }),
      },
    }),
    ...(task.escalation !== undefined && { escalation: task.escalation.map(omittedText) }),
    ...(task.evidence !== undefined && { evidence: task.evidence.map(omittedText) }),
  };
}

function projectQueuedMessageForTranscriptPolicy(
  message: WorkflowQueuedMessage,
): WorkflowQueuedMessage {
  return {
    ...message,
    text: TRANSCRIPT_OMITTED_MESSAGE,
    ...(message.question !== undefined && { question: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

function projectRecoveryFactsForTranscriptPolicy(
  facts: Record<string, RecoveryFact>,
): Record<string, RecoveryFact> {
  return Object.fromEntries(
    Object.entries(facts).map(([key, value]) => [
      key,
      typeof value === 'string' ? TRANSCRIPT_OMITTED_MESSAGE : value,
    ]),
  );
}

function omittedText(): string {
  return TRANSCRIPT_OMITTED_MESSAGE;
}

function assertInsideRoot(projectDir: string, fullPath: string): void {
  const realRoot = nearestExistingAncestor(projectDir);
  const realTarget = nearestExistingAncestor(fullPath);
  if (!isInsideRoot(realRoot, realTarget)) {
    throw pathConfinementError.escapesRoot(relative(projectDir, fullPath));
  }
}

function assertSessionDirConfined(projectDir: string, sessionId: string): void {
  validateSessionId(sessionId);
  const sessionRel = join(DIPTYCH_DIR, SESSIONS_DIR, sessionId);
  assertPathConfined(sessionRel, projectDir);
  assertInsideRoot(projectDir, resolve(projectDir, sessionRel));
}

type StateCacheEntry = { mtimeMs: number; size: number; state: WorkflowState };

const STATE_CACHE_MAX_ENTRIES = 64;
const stateCache = new Map<string, StateCacheEntry>();

function cacheState(filePath: string, entry: StateCacheEntry): void {
  stateCache.delete(filePath);
  stateCache.set(filePath, entry);
  while (stateCache.size > STATE_CACHE_MAX_ENTRIES) {
    const oldest = stateCache.keys().next().value;
    if (oldest === undefined) break;
    stateCache.delete(oldest);
  }
}

export function saveState(ref: SessionRef, state: WorkflowState): void {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  confinedWriteFile(
    ref.projectDir,
    join(DIPTYCH_DIR, SESSIONS_DIR, ref.sessionId, STATE_FILE),
    JSON.stringify(state, null, 2) + '\n',
  );
  const filePath = join(sessionDir(ref.projectDir, ref.sessionId), STATE_FILE);
  const parsed =
    state.stateVersion === CURRENT_STATE_VERSION ? WorkflowStateSchema.safeParse(state) : null;
  if (!parsed?.success) {
    stateCache.delete(filePath);
    return;
  }
  try {
    const stat = statSync(filePath);
    cacheState(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      state: normalizeLoadedWorkflowState(parsed.data),
    });
  } catch {
    stateCache.delete(filePath);
  }
}

export function loadState(ref: SessionRef): WorkflowState | null {
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  const filePath = join(dir, STATE_FILE);
  if (!existsSync(filePath)) return null;
  try {
    rejectSymlinkTarget(filePath);
  } catch {
    warnStderr('Warning: refusing to read state through symlink, ignoring');
    return null;
  }
  assertExistingPathConfined(
    `${DIPTYCH_DIR}/${SESSIONS_DIR}/${ref.sessionId}/${STATE_FILE}`,
    ref.projectDir,
  );
  let stat: ReturnType<typeof statSync>;
  let raw: unknown;
  try {
    stat = statSync(filePath);
    const cached = stateCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      cacheState(filePath, cached);
      return cached.state;
    }
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    warnStderr('Warning: corrupt state file, ignoring');
    return null;
  }
  const record = narrowRecord(raw);
  if (!record) {
    warnStderr('Warning: state file is not an object, ignoring');
    return null;
  }
  if (record.stateVersion !== CURRENT_STATE_VERSION) {
    warnStderr(
      `Warning: state file version ${String(record.stateVersion)} is incompatible with version ${CURRENT_STATE_VERSION}, ignoring`,
    );
    return null;
  }
  const result = WorkflowStateSchema.safeParse(raw);
  if (!result.success) {
    warnStderr('Warning: state file failed schema validation, ignoring');
    return null;
  }
  const state = normalizeLoadedWorkflowState(result.data);
  cacheState(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, state });
  return state;
}

export type SessionLogAppender = (entry: SessionLogMessageEntry | SessionLogEventEntry) => void;

export type SessionLogAppendFailure =
  | 'invalid-entry'
  | 'oversized-entry'
  | 'symlink-write'
  | 'write-failed';

export function createSessionLogAppender(
  ref: SessionRef,
  opts: { onFailure?: ((failure: SessionLogAppendFailure) => void) | undefined } = {},
): SessionLogAppender {
  const sessionRel = join(DIPTYCH_DIR, SESSIONS_DIR, ref.sessionId);
  const logRel = join(sessionRel, SESSION_LOG_FILE);
  const logFile = resolve(ref.projectDir, logRel);
  let ensured = false;
  return (entry) => {
    try {
      if (!ensured) {
        assertSessionDirConfined(ref.projectDir, ref.sessionId);
        confinedEnsureDir(ref.projectDir, sessionRel);
        ensured = true;
      }
      const parsed = SessionLogEntrySchema.safeParse(entry);
      if (!parsed.success) {
        opts.onFailure?.('invalid-entry');
        warnStderr('Warning: failed to persist invalid log entry');
        return;
      }
      const line = JSON.stringify(parsed.data) + '\n';
      if (Buffer.byteLength(line, 'utf8') > SESSION_LOG_MAX_ENTRY_BYTES) {
        opts.onFailure?.('oversized-entry');
        warnStderr(
          `Warning: failed to persist oversized log entry exceeding ${SESSION_LOG_MAX_ENTRY_BYTES} bytes`,
        );
        return;
      }
      rejectSymlinkTarget(logFile);
      confinedAppendFileSync(ref.projectDir, logRel, line);
    } catch (err) {
      if (fsError.isSymlinkWrite(err)) {
        opts.onFailure?.('symlink-write');
        throw err;
      }
      opts.onFailure?.('write-failed');
      warnStderr(`Warning: failed to persist log entry: ${toErrorMessage(err)}`);
    }
  };
}

function appendLine(ref: SessionRef, entry: SessionLogMessageEntry | SessionLogEventEntry): void {
  createSessionLogAppender(ref)(entry);
}

export function toEngineEventEntry<TEvent extends { type: string; ts: number }>(
  event: TEvent,
): SessionLogEventEntry {
  const { type, ts, ...rest } = event;
  const data: Record<string, unknown> = { ...rest };
  const phase = PhaseSchema.safeParse(data['phase']);
  const taskId = TaskIdSchema.safeParse(data['taskId']);
  delete data['phase'];
  delete data['taskId'];
  return {
    kind: 'event',
    ts: new Date(ts).toISOString(),
    type,
    ...(phase.success && { phase: phase.data }),
    ...(taskId.success && { taskId: taskId.data }),
    data,
  };
}

export function appendMessage(
  ref: SessionRef,
  message: Omit<SessionLogMessageEntry, 'ts' | 'kind'>,
  opts: { persistTranscript: boolean },
): void {
  if (!opts.persistTranscript) return;
  const entry: SessionLogMessageEntry = {
    kind: 'message',
    ts: nowIso(),
    ...message,
  };
  appendLine(ref, entry);
}

export function appendEngineEvent<TEvent extends { type: string; ts: number }>(
  ref: SessionRef,
  event: TEvent,
): void {
  appendLine(ref, toEngineEventEntry(event));
}

export function appendProtectedEngineEvent<TEvent extends { type: string; ts: number }>(
  ref: SessionRef,
  event: TEvent,
  schema: z.ZodType<TEvent>,
): void {
  const protectedEvent = protectConsumerPayload({ context: 'session-log', payload: event });
  if (protectedEvent.oversized) return;

  const parsedEvent = schema.safeParse(protectedEvent.payload);
  if (!parsedEvent.success) return;

  const protectedEntry = protectConsumerPayload({
    context: 'session-log',
    payload: toEngineEventEntry(parsedEvent.data),
  });
  if (protectedEntry.oversized) return;

  const parsedEntry = SessionLogEventEntrySchema.safeParse(protectedEntry.payload);
  if (!parsedEntry.success) return;

  appendLine(ref, parsedEntry.data);
}
