import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../schemas/workflow.js';
import { WorkflowStateSchema, WORKFLOW_STATE_VERSION } from '../schemas/workflow.js';
import type { SessionRef } from '../types/session-ref.js';
import { LEGACY_STATE_VERSION, legacyWorkflowStateSchema } from './migration/legacy-state.js';
import { mapV3StateToV4 } from './migration/map-v3.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR, STATE_FILE, sessionDir } from '../paths.js';
import {
  cacheRevision,
  cacheStateSnapshot,
  cachedStateFor,
  classifyStateVersion,
  forgetCachedState,
  readRawState,
  serializedState,
  statePath,
} from './state-file.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { rejectSymlinkTarget, SECURE_FILE_MODE } from '../../lib/fs.js';
import { confinedEnsureDir } from '../../lib/confined-fs.js';
import { confinedAtomicWriteFileSync } from '../../lib/confined-fs-atomic.js';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import { warnStderr } from '../../lib/warn.js';
import { assertSessionDirConfined } from '../sessions/confinement.js';

export function saveState(ref: SessionRef, state: WorkflowState): void {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  const parsed =
    state.stateVersion === WORKFLOW_STATE_VERSION
      ? WorkflowStateSchema.safeParse(state)
      : state.stateVersion === LEGACY_STATE_VERSION
        ? legacyWorkflowStateSchema.safeParse(state)
        : null;
  if (!parsed?.success) return;

  const current = readRawState(ref);
  if (current.kind === 'malformed' && current.revision === undefined) return;
  const expectedRevision =
    current.kind === 'present'
      ? current.raw.revision
      : current.kind === 'malformed'
        ? (current.revision ?? null)
        : null;

  confinedEnsureDir(ref.projectDir, join(SPLITBRIEF_DIR, SESSIONS_DIR, ref.sessionId));
  const filePath = statePath(ref);
  const write = confinedAtomicWriteFileSync(filePath, serializedState(parsed.data), {
    expectedRevision,
    mode: SECURE_FILE_MODE,
  });
  if (write.kind !== 'written') return;
  if (state.stateVersion !== WORKFLOW_STATE_VERSION) {
    forgetCachedState(filePath);
    return;
  }
  cacheRevision(filePath, write.revision, parsed.data);
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
    `${SPLITBRIEF_DIR}/${SESSIONS_DIR}/${ref.sessionId}/${STATE_FILE}`,
    ref.projectDir,
  );
  const cacheKey = statePath(ref);
  let stat: ReturnType<typeof statSync>;
  let raw: unknown;
  try {
    stat = statSync(filePath);
    const cached = cachedStateFor(cacheKey, stat.mtimeMs, stat.size);
    if (cached !== null) return cached;
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
  if (record.stateVersion === LEGACY_STATE_VERSION) {
    const classification = classifyStateVersion(raw);
    if (classification.kind !== 'v3') {
      warnStderr('Warning: state file failed schema validation, ignoring');
      return null;
    }
    const state = mapV3StateToV4({ ref, state: classification.state, stateRevision: 1 });
    if (state === null) {
      warnStderr('Warning: state file failed schema validation, ignoring');
      return null;
    }
    cacheStateSnapshot(cacheKey, stat.mtimeMs, stat.size, state);
    return state;
  }
  if (record.stateVersion !== WORKFLOW_STATE_VERSION) {
    warnStderr(
      `Warning: state file version ${String(record.stateVersion)} is incompatible with version ${WORKFLOW_STATE_VERSION}, ignoring`,
    );
    return null;
  }
  const result = WorkflowStateSchema.safeParse(raw);
  if (!result.success) {
    warnStderr('Warning: state file failed schema validation, ignoring');
    return null;
  }
  const state = result.data;
  cacheStateSnapshot(cacheKey, stat.mtimeMs, stat.size, state);
  return state;
}
