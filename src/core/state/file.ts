import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../schemas/workflow/state.js';
import { WorkflowStateSchema, WORKFLOW_STATE_VERSION } from '../schemas/workflow/state.js';
import type { SessionRef } from '../types/session-ref.js';
import {
  LEGACY_STATE_VERSION,
  legacyWorkflowStateSchema,
  type LegacyWorkflowState,
} from './migration/legacy-state.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR, STATE_FILE, sessionDir } from '../paths.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { sha256Hex } from '../../utils/sha256.js';
import { rejectSymlinkTarget } from '../../lib/fs/secure.js';
import { revisionFromStat } from '../../lib/fs/atomic-write/revision.js';
import type { ConfigRevision } from '../../lib/fs/atomic-write/types.js';
import { assertExistingPathConfined } from '../../lib/fs/confinement.js';
import { assertSessionDirConfined } from '../sessions/confinement.js';

type RawStateRevision = {
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

export function statePath(ref: SessionRef): string {
  const directory = sessionDir(ref.projectDir, ref.sessionId);
  try {
    return join(realpathSync(directory), STATE_FILE);
  } catch {
    return join(directory, STATE_FILE);
  }
}

export function readStateFile(
  filePath: string,
):
  | { kind: 'malformed'; message: string; cause?: unknown }
  | { kind: 'present'; bytes: Buffer; revision: ConfigRevision } {
  try {
    const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd, { bigint: true }).isFile())
        return { kind: 'malformed', message: 'State path is not a regular file.' };
      const bytes = readFileSync(fd);
      const stat = fstatSync(fd, { bigint: true });
      const revision = revisionFromStat(sha256Hex(bytes), stat);
      return { kind: 'present', bytes, revision };
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    return {
      kind: 'malformed',
      message: `State file cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    };
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

  const file = readStateFile(filePath);
  if (file.kind === 'malformed') return file;
  const { bytes, revision } = file;
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
