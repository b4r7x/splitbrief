import { existsSync, readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../schemas/workflow.js';
import { WorkflowStateSchema, WORKFLOW_STATE_VERSION } from '../schemas/workflow.js';
import type { SessionRef } from '../types/session-ref.js';
import {
  LEGACY_STATE_VERSION,
  legacyWorkflowStateSchema,
  type LegacyWorkflowState,
} from './migration/legacy-state.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR, STATE_FILE, sessionDir } from '../paths.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { sha256Hex } from '../../utils/sha256.js';
import { rejectSymlinkTarget } from '../../lib/fs.js';
import type { ConfigRevision } from '../../lib/confined-fs-atomic.js';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import { assertSessionDirConfined } from '../sessions/confinement.js';

type StateCacheEntry = { mtimeMs: number; size: number; state: WorkflowState };

const STATE_CACHE_MAX_ENTRIES = 64;
const stateCache = new Map<string, StateCacheEntry>();

export type RawStateRevision = {
  readonly bytes: Buffer;
  readonly value: unknown;
  readonly revision: ConfigRevision;
  readonly digest: string;
};

type RawStateRead =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'malformed';
      readonly message: string;
      readonly digest?: string;
      readonly revision?: ConfigRevision;
    }
  | { readonly kind: 'present'; readonly raw: RawStateRevision };

function cacheState(filePath: string, entry: StateCacheEntry): void {
  stateCache.delete(filePath);
  stateCache.set(filePath, entry);
  while (stateCache.size > STATE_CACHE_MAX_ENTRIES) {
    const oldest = stateCache.keys().next().value;
    if (oldest === undefined) break;
    stateCache.delete(oldest);
  }
}

export function cachedStateFor(
  filePath: string,
  mtimeMs: number,
  size: number,
): WorkflowState | null {
  const cached = stateCache.get(filePath);
  if (cached === undefined || cached.mtimeMs !== mtimeMs || cached.size !== size) return null;
  cacheState(filePath, cached);
  return cached.state;
}

export function cacheStateSnapshot(
  filePath: string,
  mtimeMs: number,
  size: number,
  state: WorkflowState,
): void {
  cacheState(filePath, { mtimeMs, size, state });
}

export function forgetCachedState(filePath: string): void {
  stateCache.delete(filePath);
}

export function cacheRevision(
  filePath: string,
  revision: ConfigRevision,
  state: WorkflowState,
): void {
  cacheState(filePath, {
    mtimeMs: Number(revision.fileIdentity.mtimeNs / 1_000_000n),
    size: Number(revision.fileIdentity.size),
    state,
  });
}

export function cacheRawState(filePath: string, raw: RawStateRevision, state: WorkflowState): void {
  const mtimeNs = raw.revision.fileIdentity.mtimeNs;
  cacheState(filePath, {
    mtimeMs: Number(mtimeNs / 1_000_000n),
    size: Number(raw.revision.fileIdentity.size),
    state,
  });
}

function revisionFromBytes(bytes: Uint8Array, stat: BigIntStats): ConfigRevision {
  return {
    rawSha256: sha256Hex(bytes),
    fileIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
    },
  };
}

export function revisionsMatch(left: ConfigRevision, right: ConfigRevision): boolean {
  return (
    left.rawSha256 === right.rawSha256 &&
    left.fileIdentity.dev === right.fileIdentity.dev &&
    left.fileIdentity.ino === right.fileIdentity.ino &&
    left.fileIdentity.size === right.fileIdentity.size &&
    left.fileIdentity.mtimeNs === right.fileIdentity.mtimeNs
  );
}

export function statePath(ref: SessionRef): string {
  const directory = sessionDir(ref.projectDir, ref.sessionId);
  try {
    return join(realpathSync(directory), STATE_FILE);
  } catch {
    return join(directory, STATE_FILE);
  }
}

export function readRawState(ref: SessionRef): RawStateRead {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  const filePath = statePath(ref);
  if (!existsSync(filePath)) return { kind: 'missing' };

  try {
    rejectSymlinkTarget(filePath);
    assertExistingPathConfined(
      `${SPLITBRIEF_DIR}/${SESSIONS_DIR}/${ref.sessionId}/${STATE_FILE}`,
      ref.projectDir,
    );
  } catch (cause) {
    return {
      kind: 'malformed',
      message: `State file cannot be read safely: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  let bytes: Buffer;
  let stat: BigIntStats;
  try {
    bytes = readFileSync(filePath);
    stat = statSync(filePath, { bigint: true });
    if (!stat.isFile()) {
      return { kind: 'malformed', message: 'State path is not a regular file.' };
    }
  } catch (cause) {
    return {
      kind: 'malformed',
      message: `State file cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const revision = revisionFromBytes(bytes, stat);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    return {
      kind: 'malformed',
      digest: revision.rawSha256,
      revision,
      message: `State file contains invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  return { kind: 'present', raw: { bytes, value, revision, digest: revision.rawSha256 } };
}

export function classifyStateVersion(
  raw: unknown,
):
  | { kind: 'malformed'; message: string }
  | { kind: 'future-version'; message: string }
  | { kind: 'v3'; state: LegacyWorkflowState }
  | { kind: 'v4'; state: WorkflowState } {
  const record = narrowRecord(raw);
  if (record === null) return { kind: 'malformed', message: 'State file is not an object.' };
  const stateVersion = record.stateVersion;
  if (typeof stateVersion !== 'number' || !Number.isInteger(stateVersion)) {
    return { kind: 'malformed', message: 'State file has no integer stateVersion.' };
  }
  if (stateVersion > WORKFLOW_STATE_VERSION) {
    return {
      kind: 'future-version',
      message: `State file version ${stateVersion} is newer than supported version ${WORKFLOW_STATE_VERSION}.`,
    };
  }
  if (stateVersion === LEGACY_STATE_VERSION) {
    if (containsFutureNestedVersion(raw)) {
      return {
        kind: 'future-version',
        message: 'State file contains a nested version newer than supported v1 recovery schemas.',
      };
    }
    const parsed = legacyWorkflowStateSchema.safeParse(raw);
    if (!parsed.success) {
      return { kind: 'malformed', message: 'State file failed legacy v3 schema validation.' };
    }
    return { kind: 'v3', state: parsed.data };
  }
  if (stateVersion === WORKFLOW_STATE_VERSION) {
    const parsed = WorkflowStateSchema.safeParse(raw);
    if (!parsed.success) {
      if (containsFutureNestedVersion(raw)) {
        return {
          kind: 'future-version',
          message: `State file contains a nested version newer than supported v1 recovery schemas.`,
        };
      }
      return { kind: 'malformed', message: 'State file failed current v4 schema validation.' };
    }
    return { kind: 'v4', state: parsed.data };
  }
  return {
    kind: 'malformed',
    message: `State file version ${stateVersion} is unsupported; only v3 can be migrated.`,
  };
}

function containsFutureNestedVersion(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsFutureNestedVersion);
  const record = narrowRecord(value);
  if (record === null) return false;
  for (const [key, nested] of Object.entries(record)) {
    if (key === 'version' && typeof nested === 'number' && nested > 1) return true;
    if (containsFutureNestedVersion(nested)) return true;
  }
  return false;
}

export function serializedState(state: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function workflowStateDigest(state: WorkflowState): string {
  return sha256Hex(serializedState(state));
}
