import type { SessionRef } from '../../types/session-ref.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { error } from '../../../utils/error.js';
import { recoverySidecarPath } from './paths.js';
import type {
  RecoveryEpochManifest,
  RecoveryEvidenceRecord,
  RecoveryEvidenceRef,
  RecoverySidecarKind,
} from './schema.js';
import { artifactRef, canonicalPayload, writeCreateExclusive } from './artifacts.js';
import { appendRecoveryRecord, readRecoveryJournal } from './journal.js';
import { readRecoveryEpochManifest } from './epoch.js';

export type RecoverySidecarWriteInput = Readonly<{
  epochId: string;
  operationId: string;
  kind: RecoverySidecarKind;
  payload: unknown;
  intentHash?: string | undefined;
}>;

export type RecoverySidecarResult = Readonly<{
  ref: RecoveryEvidenceRef;
  record: RecoveryEvidenceRecord;
  manifest: RecoveryEpochManifest;
}>;

export type RecoveryReplayResult = Readonly<{
  manifest: RecoveryEpochManifest;
  receipt: RecoveryEvidenceRecord | null;
  sidecar: RecoverySidecarResult;
}>;

export function writeRecoverySidecar(
  ref: SessionRef,
  input: RecoverySidecarWriteInput,
): RecoverySidecarResult {
  const manifest = readRecoveryEpochManifest(ref, input.epochId);
  if (manifest === null) throw error('recovery-evidence-storage', 'recovery epoch is not closed');
  const { bytes, hash } = canonicalPayload(input.payload);
  const eventId = `sidecar-${sha256Hex(
    canonicalJSON({
      epochId: input.epochId,
      operationId: input.operationId,
      kind: input.kind,
      hash,
    }),
  ).slice(0, 48)}`;
  const filePath = recoverySidecarPath(ref, input.epochId, input.operationId, input.kind, hash);
  writeCreateExclusive(ref, filePath, bytes);
  const payload = artifactRef(ref, filePath, hash);
  const record = appendRecoveryRecord({
    ref,
    epochId: input.epochId,
    kind: input.kind,
    operationId: input.operationId,
    eventId,
    payloadRef: payload,
    refs: [manifest.manifestHash, ...(input.intentHash === undefined ? [] : [input.intentHash])],
    after: null,
  });
  return { ref: payload, record, manifest };
}

export function replayClosedRecovery(
  ref: SessionRef,
  input: Readonly<{ epochId: string; operationId: string; intentHash?: string | undefined }>,
): RecoveryReplayResult {
  const manifest = readRecoveryEpochManifest(ref, input.epochId);
  if (manifest === null) throw error('recovery-evidence-storage', 'recovery epoch is not closed');
  const journal = readRecoveryJournal(ref);
  const receipt =
    [...journal.records]
      .reverse()
      .find(
        (record) =>
          record.epochId === input.epochId &&
          record.operationId === input.operationId &&
          ['receipt', 'outcome', 'provider-failure', 'storage-failure', 'rejection'].includes(
            record.kind,
          ),
      ) ?? null;
  const sidecar = writeRecoverySidecar(ref, {
    epochId: input.epochId,
    operationId: input.operationId,
    kind: 'replay',
    payload: {
      operationId: input.operationId,
      intentHash: input.intentHash ?? null,
      receipt: receipt?.recordHash ?? null,
    },
    intentHash: input.intentHash,
  });
  return { manifest, receipt, sidecar };
}
