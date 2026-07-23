import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../schemas/workflow.js';
import { WorkflowStateSchema } from '../schemas/workflow.js';
import { CURRENT_STATE_VERSION } from './machine.js';
import { normalizeLoadedWorkflowState } from '../queue-state.js';
import type { SessionRef } from '../types/session-ref.js';
import { DIPTYCH_DIR, SESSIONS_DIR, STATE_FILE, sessionDir } from '../paths.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { rejectSymlinkTarget } from '../../lib/fs.js';
import { confinedWriteFile } from '../../lib/confined-fs.js';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import { warnStderr } from '../../lib/warn.js';
import { assertSessionDirConfined } from '../sessions/confinement.js';

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
