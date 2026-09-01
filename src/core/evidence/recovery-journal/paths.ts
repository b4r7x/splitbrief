import { join, relative, sep } from 'node:path';
import { sessionDir } from '../../paths.js';
import type { SessionRef } from '../../types/session-ref.js';
import { assertWritablePathConfined } from '../../../lib/path-confinement.js';
import { error } from '../../../utils/error.js';
import { recoveryHash, recoveryIdentifier, recoveryPath } from './schema.js';
import type { RecoverySidecarKind } from './schema.js';

const RECOVERY_JOURNAL_FILE = 'brief-recovery.jsonl';
export const RECOVERY_ROOT = 'brief-recovery';
export const RECOVERY_EPOCHS_DIR = 'epochs';
const RECOVERY_PAYLOAD_DIR = 'payload';
export const RECOVERY_SIDECAR_DIR = 'sidecars';
const RECOVERY_MANIFEST_FILE = 'manifest.json';

export function isRecoveryPayloadPath(value: string): boolean {
  return recoveryPath.safeParse(value).success && value.startsWith(`${RECOVERY_ROOT}/`);
}

export function assertRecoveryIdentifier(value: string, label: string): void {
  if (!recoveryIdentifier.safeParse(value).success) {
    throw error('recovery-evidence-storage', `Invalid recovery ${label}`);
  }
}

export function assertRecoveryHash(value: string, label: string): void {
  if (!recoveryHash.safeParse(value).success)
    throw error('recovery-evidence-storage', `Invalid recovery ${label}`);
}

export function recoveryJournalPath(ref: SessionRef): string {
  return join(sessionDir(ref.projectDir, ref.sessionId), RECOVERY_JOURNAL_FILE);
}

export function recoveryEpochDir(ref: SessionRef, epochId: string): string {
  assertRecoveryIdentifier(epochId, 'epoch id');
  return join(
    sessionDir(ref.projectDir, ref.sessionId),
    RECOVERY_ROOT,
    RECOVERY_EPOCHS_DIR,
    epochId,
  );
}

export function recoveryManifestPath(ref: SessionRef, epochId: string): string {
  return join(recoveryEpochDir(ref, epochId), RECOVERY_MANIFEST_FILE);
}

export function recoverySidecarDir(ref: SessionRef, epochId: string): string {
  return join(recoveryEpochDir(ref, epochId), RECOVERY_SIDECAR_DIR);
}

export function recoveryArtifactPath(
  ref: SessionRef,
  epochId: string,
  eventId: string,
  payloadHash: string,
): string {
  assertRecoveryIdentifier(epochId, 'epoch id');
  assertRecoveryIdentifier(eventId, 'event id');
  assertRecoveryHash(payloadHash, 'payload hash');
  return join(
    recoveryEpochDir(ref, epochId),
    RECOVERY_PAYLOAD_DIR,
    `${eventId}-${payloadHash}.json`,
  );
}

export function recoverySidecarPath(
  ref: SessionRef,
  epochId: string,
  operationId: string,
  kind: RecoverySidecarKind,
  payloadHash: string,
): string {
  assertRecoveryIdentifier(operationId, 'operation id');
  assertRecoveryHash(payloadHash, 'payload hash');
  return join(recoverySidecarDir(ref, epochId), `${operationId}-${kind}-${payloadHash}.json`);
}

export function recoveryProjectPath(ref: SessionRef, absolutePath: string): string {
  const session = sessionDir(ref.projectDir, ref.sessionId);
  const projectRelative = relative(ref.projectDir, absolutePath).split(sep).join('/');
  if (projectRelative.length === 0 || projectRelative.startsWith('../')) {
    throw error('recovery-evidence-storage', 'recovery evidence path escaped the project');
  }
  assertWritablePathConfined(projectRelative, ref.projectDir);
  return relative(session, absolutePath).split(sep).join('/');
}
