import { existsSync, readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { SessionRef } from '../../types/session-ref.js';
import { rejectSymlinkTarget } from '../../../lib/fs.js';
import { assertExistingPathConfined } from '../../../lib/path-confinement.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { error } from '../../../utils/error.js';
import {
  RECOVERY_EPOCHS_DIR,
  RECOVERY_ROOT,
  RECOVERY_SIDECAR_DIR,
  assertRecoveryHash,
  isRecoveryPayloadPath,
  recoveryManifestPath,
} from './paths.js';
import { recoveryManifestSchema } from './schema.js';
import type { RecoveryEpochManifest, RecoveryOutboxEntry } from './schema.js';
import { writeCreateExclusive } from './artifacts.js';
import { writeRecoveryEvidence } from './journal.js';

export type RecoveryEpochCloseInput = Readonly<{
  epochId: string;
  disposition: RecoveryEpochManifest['disposition'];
  closedAt: string;
  headHash: string;
  outbox?: readonly RecoveryOutboxEntry[] | undefined;
}>;

function manifestHash(manifest: Omit<RecoveryEpochManifest, 'manifestHash'>): string {
  return sha256Hex(canonicalJSON(manifest));
}

function writeManifestExclusive(
  ref: SessionRef,
  manifest: RecoveryEpochManifest,
): RecoveryEpochManifest {
  const parsed = recoveryManifestSchema.safeParse(manifest);
  if (!parsed.success)
    throw error('recovery-evidence-storage', 'recovery epoch manifest failed its bounded schema');
  const filePath = recoveryManifestPath(ref, manifest.epochId);
  const bytes = Buffer.from(`${canonicalJSON(parsed.data)}\n`, 'utf8');
  if (existsSync(filePath)) {
    rejectSymlinkTarget(filePath);
    const existing = recoveryManifestSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')));
    if (!existing.success || canonicalJSON(existing.data) !== canonicalJSON(parsed.data)) {
      throw error('recovery-evidence-storage', 'recovery epoch manifest is immutable');
    }
    return existing.data;
  }
  writeCreateExclusive(ref, filePath, bytes);
  return parsed.data;
}

export function readRecoveryEpochManifest(
  ref: SessionRef,
  epochId: string,
): RecoveryEpochManifest | null {
  const filePath = recoveryManifestPath(ref, epochId);
  if (!existsSync(filePath)) return null;
  const projectRelative = relative(ref.projectDir, filePath).split(sep).join('/');
  assertExistingPathConfined(projectRelative, ref.projectDir);
  rejectSymlinkTarget(filePath);
  const parsed = recoveryManifestSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')));
  if (!parsed.success)
    throw error('recovery-evidence-storage', 'recovery epoch manifest is invalid');
  if (parsed.data.outbox.some((entry) => !isRecoveryPayloadPath(entry.payloadRef))) {
    throw error(
      'recovery-evidence-storage',
      'recovery epoch manifest has an out-of-namespace outbox reference',
    );
  }
  const { manifestHash: supplied, ...withoutHash } = parsed.data;
  if (manifestHash(withoutHash) !== supplied)
    throw error('recovery-evidence-storage', 'recovery epoch manifest hash mismatch');
  return parsed.data;
}

export function closeRecoveryEpoch(
  ref: SessionRef,
  input: RecoveryEpochCloseInput,
): RecoveryEpochManifest {
  const existing = readRecoveryEpochManifest(ref, input.epochId);
  if (existing !== null) {
    if (
      existing.disposition !== input.disposition ||
      existing.headHash !== input.headHash ||
      existing.closedAt !== input.closedAt ||
      canonicalJSON(existing.outbox) !== canonicalJSON(input.outbox ?? [])
    ) {
      throw error(
        'recovery-evidence-storage',
        'recovery epoch is already closed with a different disposition',
      );
    }
    return existing;
  }
  assertRecoveryHash(input.headHash, 'epoch head hash');
  const closure = writeRecoveryEvidence(ref, {
    epochId: input.epochId,
    kind: 'epoch-closed',
    eventId: `epoch-closed-${sha256Hex(canonicalJSON({ epochId: input.epochId })).slice(0, 48)}`,
    payload: {
      disposition: input.disposition,
      closedAt: input.closedAt,
      headHash: input.headHash,
    },
    after: null,
  });
  const withoutHash: Omit<RecoveryEpochManifest, 'manifestHash'> = {
    version: 1,
    sessionId: ref.sessionId,
    epochId: input.epochId,
    disposition: input.disposition,
    closedAt: input.closedAt,
    headHash: input.headHash,
    journalHead: closure.record.recordHash,
    sidecarNamespace: `${RECOVERY_ROOT}/${RECOVERY_EPOCHS_DIR}/${input.epochId}/${RECOVERY_SIDECAR_DIR}`,
    outbox: [...(input.outbox ?? [])],
  };
  if (withoutHash.outbox.some((entry) => !isRecoveryPayloadPath(entry.payloadRef))) {
    throw error(
      'recovery-evidence-storage',
      'recovery epoch outbox reference is outside the recovery namespace',
    );
  }
  return writeManifestExclusive(ref, {
    ...withoutHash,
    manifestHash: manifestHash(withoutHash),
  });
}
