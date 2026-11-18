import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../schemas/workflow/state.js';
import { WorkflowStateSchema, WORKFLOW_STATE_VERSION } from '../schemas/workflow/state.js';
import type { SessionRef } from '../types/session-ref.js';
import { LEGACY_STATE_VERSION, legacyWorkflowStateSchema } from './migration/legacy-state.js';
import { mapV3StateToV4 } from './migration/map-v3.js';
import { STATE_FILE, sessionDir } from '../paths.js';
import {
  classifyStateVersion,
  readRawState,
  readStateFile,
  serializedState,
  statePath,
} from './file.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { rejectSymlinkTarget, SECURE_FILE_MODE } from '../../lib/fs/secure.js';
import { confinedEnsureDir } from '../../lib/fs/confined.js';
import { revisionsMatch } from '../../lib/fs/atomic-write/revision.js';
import type { ConfigRevision } from '../../lib/fs/atomic-write/types.js';
import { confinedAtomicWriteFileSync } from '../../lib/fs/atomic-write/write-sync.js';
import { assertExistingPathConfined } from '../../lib/fs/confinement.js';
import { warnStderr } from '../../lib/warn.js';
import { assertSessionDirConfined } from '../sessions/confinement.js';
import { sessionRelativePath } from '../sessions/ownership-marker.js';

const STATE_CACHE_MAX_ENTRIES = 64;
const stateCache = new Map<string, { revision: ConfigRevision; state: WorkflowState }>();

function cacheRevision(filePath: string, revision: ConfigRevision, state: WorkflowState): void {
  stateCache.delete(filePath);
  stateCache.set(filePath, { revision, state });
  while (stateCache.size > STATE_CACHE_MAX_ENTRIES) {
    const oldest = stateCache.keys().next().value;
    if (oldest === undefined) break;
    stateCache.delete(oldest);
  }
}

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

  confinedEnsureDir(ref.projectDir, sessionRelativePath(ref.sessionId));
  const filePath = statePath(ref);
  const write = confinedAtomicWriteFileSync(filePath, serializedState(parsed.data), {
    expectedRevision,
    mode: SECURE_FILE_MODE,
  });
  if (write.kind !== 'written') return;
  if (state.stateVersion !== WORKFLOW_STATE_VERSION) {
    stateCache.delete(filePath);
    return;
  }
  cacheRevision(filePath, write.revision, parsed.data);
}

export function loadState(ref: SessionRef): WorkflowState | null {
  const result = loadStateWithRevision(ref);
  return result.kind === 'loaded' ? result.state : null;
}

type StateLoad =
  | { kind: 'missing' }
  | { kind: 'invalid'; cause?: unknown }
  | { kind: 'loaded'; state: WorkflowState; bytes: Buffer; revision: ConfigRevision };

function skipState(relativePath: string, reason: string, cause?: unknown): StateLoad {
  warnStderr(`Warning: skipped ${relativePath}: ${reason}`);
  return { kind: 'invalid', cause };
}

export function loadStateWithRevision(ref: SessionRef): StateLoad {
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  const filePath = join(dir, STATE_FILE);
  if (!existsSync(filePath)) return { kind: 'missing' };
  const relativePath = sessionRelativePath(ref.sessionId, STATE_FILE);
  try {
    rejectSymlinkTarget(filePath);
  } catch {
    return skipState(relativePath, 'it is a symbolic link');
  }
  assertExistingPathConfined(relativePath, ref.projectDir);
  const cacheKey = statePath(ref);
  const file = readStateFile(filePath);
  if (file.kind === 'malformed') return skipState(relativePath, 'it could not be read', file.cause);
  const { bytes, revision } = file;
  const cached = stateCache.get(cacheKey);
  if (cached !== undefined && revisionsMatch(cached.revision, revision)) {
    cacheRevision(cacheKey, revision, cached.state);
    return { kind: 'loaded', state: cached.state, bytes, revision };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return skipState(relativePath, 'it could not be read');
  }
  const record = narrowRecord(raw);
  if (!record) return skipState(relativePath, 'it is not a JSON object');
  if (record.stateVersion === LEGACY_STATE_VERSION) {
    const classification = classifyStateVersion(raw);
    if (classification.kind !== 'v3') {
      return skipState(relativePath, 'its content is not valid');
    }
    const state = mapV3StateToV4({ ref, state: classification.state, stateRevision: 1 });
    if (state === null) return skipState(relativePath, 'its content is not valid');
    cacheRevision(cacheKey, revision, state);
    return { kind: 'loaded', state, bytes, revision };
  }
  if (record.stateVersion !== WORKFLOW_STATE_VERSION) {
    return skipState(
      relativePath,
      `state version ${String(record.stateVersion)} is incompatible with version ${WORKFLOW_STATE_VERSION}`,
    );
  }
  const result = WorkflowStateSchema.safeParse(raw);
  if (!result.success) return skipState(relativePath, 'its content is not valid');
  const state = result.data;
  cacheRevision(cacheKey, revision, state);
  return { kind: 'loaded', state, bytes, revision };
}
