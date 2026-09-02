import type { WorkflowState } from '../schemas/workflow.js';
import { WorkflowStateSchema } from '../schemas/workflow.js';
import type { SessionRef } from '../types/session-ref.js';
import type { LegacyWorkflowState } from './migration/legacy-state.js';
import { readMigrationArtifacts, type MigrationArtifacts } from './migration/artifacts.js';
import { mapV3StateToV4 } from './migration/map-v3.js';
import type {
  ResumeLoadAuthority,
  ResumeLoadInput,
  ResumeLoadResult,
  ResumeReadPermit,
  StateAuthorityCandidate,
  StateAuthorityReceipt,
} from './types.js';
import {
  cacheRawState,
  classifyStateVersion,
  readRawState,
  revisionsMatch,
  serializedState,
  statePath,
  type RawStateRevision,
} from './state-file.js';
import { error, matches } from '../../utils/error.js';
import {
  confinedAtomicWriteFileSync,
  type ConfigRevision,
  type ExpectedConfigRevision,
} from '../../lib/confined-fs-atomic.js';
import { SECURE_FILE_MODE } from '../../lib/fs.js';
import { assertSessionDirConfined } from '../sessions/confinement.js';

export type StateAuthorityFenceCommitInput = Readonly<{
  ref: SessionRef;
  candidate: StateAuthorityCandidate;
  rawStateDigest?: string | null;
  expectedRevision?: ExpectedConfigRevision;
  nextFence: number;
}>;

export type StateAuthorityFenceCommitResult =
  | Extract<ResumeLoadAuthority, { kind: 'fenced' }>
  | Extract<ResumeLoadAuthority, { kind: 'read-only' }>
  | Readonly<{
      kind: 'conflict';
      observedRevision: ConfigRevision | null;
      message: string;
    }>
  | Readonly<{
      kind: 'durability-uncertain';
      observedRevision: ConfigRevision;
      message: string;
    }>;

export const statePersistenceError = {
  conflict: (message: string, data?: unknown) => error('state-persistence-conflict', message, data),
  authority: (message: string, data?: unknown) => error('state-authority-mismatch', message, data),
  durabilityUncertain: (message: string, data?: unknown) =>
    error('state-persistence-durability-uncertain', message, data),
  isConflict: matches('state-persistence-conflict'),
  isAuthorityMismatch: matches('state-authority-mismatch'),
  isDurabilityUncertain: matches('state-persistence-durability-uncertain'),
} as const;

function authorityMismatch(message: string, data?: unknown): never {
  throw statePersistenceError.authority(message, data);
}

function assertReceiptForRef(receipt: StateAuthorityReceipt, ref: SessionRef): void {
  if (receipt.sessionId !== ref.sessionId) {
    authorityMismatch('State authority receipt is bound to a different session.', {
      expectedSessionId: ref.sessionId,
      receiptSessionId: receipt.sessionId,
    });
  }
  if (receipt.ownerId.length === 0 || receipt.acquisitionId.length === 0) {
    authorityMismatch('State authority receipt is missing owner or acquisition identity.');
  }
  if (!Number.isInteger(receipt.fence) || receipt.fence < 0) {
    authorityMismatch('State authority receipt has an invalid fence token.');
  }
  if (!Number.isInteger(receipt.stateRevision) || receipt.stateRevision < 0) {
    authorityMismatch('State authority receipt has an invalid state revision.');
  }
}

function assertCandidateForRef(candidate: StateAuthorityCandidate, ref: SessionRef): void {
  if (candidate.kind !== 'candidate' || candidate.sessionId !== ref.sessionId) {
    authorityMismatch('State authority candidate is bound to a different session.');
  }
  if (candidate.ownerId.length === 0 || candidate.acquisitionId.length === 0) {
    authorityMismatch('State authority candidate is missing owner or acquisition identity.');
  }
  if (!Number.isInteger(candidate.fence) || candidate.fence < 0) {
    authorityMismatch('State authority candidate has an invalid fence token.');
  }
  if (!Number.isInteger(candidate.stateRevision) || candidate.stateRevision < 0) {
    authorityMismatch('State authority candidate has an invalid state revision.');
  }
  if (candidate.stateDigest !== null) {
    authorityMismatch('State authority candidate must not carry a usable state digest.');
  }
}

function permitFor(
  ref: SessionRef,
  acquisitionId: string,
  digest: string | null,
): ResumeReadPermit {
  return {
    kind: 'read-only-permit',
    sessionId: ref.sessionId,
    acquisitionId,
    rawStateDigest: digest,
  };
}

const consumedReadOnlyPermits = new Set<string>();

function permitKey(permit: ResumeReadPermit): string {
  return `${permit.sessionId}\u0000${permit.acquisitionId}\u0000${permit.rawStateDigest ?? ''}`;
}

function invalidResult(code: 'malformed' | 'future-version', message: string): ResumeLoadResult {
  return { kind: 'invalid', code, message };
}

function expectedRevisionOrCurrent(
  supplied: ExpectedConfigRevision | undefined,
  current: ConfigRevision,
): ConfigRevision {
  return supplied ?? current;
}

function receiptFrom(
  candidate: StateAuthorityCandidate,
  ref: SessionRef,
  state: WorkflowState,
  digest: string,
  fence: number,
): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId: ref.sessionId,
    ownerId: candidate.ownerId,
    pid: candidate.pid,
    processStart: candidate.processStart,
    runId: candidate.runId,
    acquisitionId: candidate.acquisitionId,
    fence,
    stateRevision: state.stateRevision ?? 0,
    stateDigest: digest,
  };
}

function receiptFromExisting(
  receipt: StateAuthorityReceipt,
  ref: SessionRef,
  state: WorkflowState,
  digest: string,
): StateAuthorityReceipt {
  return {
    ...receipt,
    sessionId: ref.sessionId,
    stateRevision: state.stateRevision ?? receipt.stateRevision,
    stateDigest: digest,
  };
}

function migrationStateFromReceipt(
  ref: SessionRef,
  state: LegacyWorkflowState,
  artifacts: MigrationArtifacts,
  receipt: StateAuthorityReceipt,
  expectedRevision: ConfigRevision,
): StateAuthorityFenceCommitResult {
  if (receipt.fence < 1) {
    authorityMismatch('A v3 migration requires a positive authority fence.');
  }
  if (receipt.stateDigest !== expectedRevision.rawSha256) {
    authorityMismatch('State authority receipt does not match the v3 state bytes.', {
      expectedDigest: expectedRevision.rawSha256,
      receiptDigest: receipt.stateDigest,
    });
  }
  const mapped = mapV3StateToV4({
    ref,
    state,
    briefBytes: artifacts.briefBytes,
    reportBytes: artifacts.reportBytes,
    ownerId: receipt.ownerId,
    fence: receipt.fence,
    stateRevision: receipt.stateRevision > 0 ? receipt.stateRevision : 1,
  });
  const path = statePath(ref);
  const write = confinedAtomicWriteFileSync(path, serializedState(mapped), {
    expectedRevision,
    mode: SECURE_FILE_MODE,
  });
  if (write.kind === 'conflict') {
    return {
      kind: 'conflict',
      observedRevision: write.observedRevision,
      message: 'v3 migration lost the expected-revision compare-and-swap.',
    };
  }
  if (write.kind === 'durability-uncertain') {
    return {
      kind: 'durability-uncertain',
      observedRevision: write.observedRevision,
      message: 'v3 migration completed but durable verification is uncertain.',
    };
  }
  const digest = write.revision.rawSha256;
  return {
    kind: 'fenced',
    receipt: receiptFromExisting(receipt, ref, mapped, digest),
    promotedFromVersion: 3,
  };
}

function migrateV3WithReceipt(
  ref: SessionRef,
  raw: RawStateRevision,
  state: LegacyWorkflowState,
  receipt: StateAuthorityReceipt,
): StateAuthorityFenceCommitResult {
  const artifacts = readMigrationArtifacts(ref);
  return migrationStateFromReceipt(ref, state, artifacts, receipt, raw.revision);
}

/**
 * Commit the authority fence and, when needed, the v3 promotion in one state
 * CAS. This is deliberately a persistence port: it does not acquire or
 * release the session authority directory.
 */
export function commitStateAuthorityFence(
  input: StateAuthorityFenceCommitInput,
): StateAuthorityFenceCommitResult {
  assertSessionDirConfined(input.ref.projectDir, input.ref.sessionId);
  assertCandidateForRef(input.candidate, input.ref);
  if (!Number.isInteger(input.nextFence) || input.nextFence < 0) {
    authorityMismatch('Next state fence must be a non-negative integer.');
  }
  const rawResult = readRawState(input.ref);
  if (rawResult.kind === 'missing') {
    return {
      kind: 'read-only',
      permit: permitFor(input.ref, input.candidate.acquisitionId, null),
    };
  }
  if (rawResult.kind === 'malformed') {
    return {
      kind: 'read-only',
      permit: permitFor(input.ref, input.candidate.acquisitionId, rawResult.digest ?? null),
    };
  }
  const raw = rawResult.raw;
  if (input.rawStateDigest !== undefined && input.rawStateDigest !== raw.digest) {
    return {
      kind: 'conflict',
      observedRevision: raw.revision,
      message: 'Fresh state digest does not match the state head on disk.',
    };
  }
  const classification = classifyStateVersion(raw.value);
  if (classification.kind === 'malformed' || classification.kind === 'future-version') {
    return {
      kind: 'read-only',
      permit: permitFor(input.ref, input.candidate.acquisitionId, raw.digest),
    };
  }
  const expectedRevision = expectedRevisionOrCurrent(input.expectedRevision, raw.revision);
  if (!revisionsMatch(expectedRevision, raw.revision)) {
    return {
      kind: 'conflict',
      observedRevision: raw.revision,
      message: 'Fresh state revision does not match the state head on disk.',
    };
  }

  if (classification.kind === 'v3') {
    if (input.candidate.fence !== 0 || input.candidate.stateRevision !== 0) {
      return {
        kind: 'conflict',
        observedRevision: raw.revision,
        message: 'Authority candidate is stale for the legacy v3 state head.',
      };
    }
    if (input.nextFence < 1) {
      authorityMismatch('The first v4 fence must be at least one.');
    }
    const artifacts = readMigrationArtifacts(input.ref);
    const mapped = mapV3StateToV4({
      ref: input.ref,
      state: classification.state,
      briefBytes: artifacts.briefBytes,
      reportBytes: artifacts.reportBytes,
      ownerId: input.candidate.ownerId,
      fence: input.nextFence,
      stateRevision: input.candidate.stateRevision > 0 ? input.candidate.stateRevision : 1,
    });
    const write = confinedAtomicWriteFileSync(statePath(input.ref), serializedState(mapped), {
      expectedRevision,
      mode: SECURE_FILE_MODE,
    });
    if (write.kind === 'conflict') {
      return {
        kind: 'conflict',
        observedRevision: write.observedRevision,
        message: 'v3 promotion lost the expected-revision compare-and-swap.',
      };
    }
    if (write.kind === 'durability-uncertain') {
      return {
        kind: 'durability-uncertain',
        observedRevision: write.observedRevision,
        message: 'v3 promotion completed but durable verification is uncertain.',
      };
    }
    return {
      kind: 'fenced',
      receipt: receiptFrom(
        input.candidate,
        input.ref,
        mapped,
        write.revision.rawSha256,
        input.nextFence,
      ),
      promotedFromVersion: 3,
    };
  }

  const current = classification.state;
  const currentFence = current.stateFence?.token ?? 0;
  const currentRevision = current.stateRevision ?? 0;
  if (input.candidate.fence !== currentFence) {
    return {
      kind: 'conflict',
      observedRevision: raw.revision,
      message: 'Authority candidate is stale for the current state fence.',
    };
  }
  if (input.candidate.stateRevision !== currentRevision) {
    return {
      kind: 'conflict',
      observedRevision: raw.revision,
      message: 'Authority candidate is stale for the current state revision.',
    };
  }
  if (input.nextFence <= currentFence) {
    return {
      kind: 'conflict',
      observedRevision: raw.revision,
      message: 'Authority fence must advance monotonically.',
    };
  }
  const fencedState = WorkflowStateSchema.parse({
    ...current,
    stateRevision: currentRevision + 1,
    stateFence: { token: input.nextFence, ownerId: input.candidate.ownerId },
  });
  const write = confinedAtomicWriteFileSync(statePath(input.ref), serializedState(fencedState), {
    expectedRevision,
    mode: SECURE_FILE_MODE,
  });
  if (write.kind === 'conflict') {
    return {
      kind: 'conflict',
      observedRevision: write.observedRevision,
      message: 'Fence advancement lost the expected-revision compare-and-swap.',
    };
  }
  if (write.kind === 'durability-uncertain') {
    return {
      kind: 'durability-uncertain',
      observedRevision: write.observedRevision,
      message: 'Fence advancement completed but durable verification is uncertain.',
    };
  }
  return {
    kind: 'fenced',
    receipt: receiptFrom(
      input.candidate,
      input.ref,
      fencedState,
      write.revision.rawSha256,
      input.nextFence,
    ),
    promotedFromVersion: null,
  };
}

export function loadStateForResume(input: ResumeLoadInput): ResumeLoadResult {
  assertSessionDirConfined(input.ref.projectDir, input.ref.sessionId);
  const authority = input.authority;
  if (authority.kind === 'fenced') assertReceiptForRef(authority.receipt, input.ref);
  const permit = authority.kind === 'read-only' ? authority.permit : null;
  if (permit !== null) {
    if (permit.sessionId !== input.ref.sessionId || permit.acquisitionId.length === 0) {
      return invalidResult('malformed', 'Read-only resume permit is not bound to this session.');
    }
    if (consumedReadOnlyPermits.has(permitKey(permit))) {
      return invalidResult('malformed', 'Read-only resume permit has already been consumed.');
    }
  }

  try {
    const rawResult = readRawState(input.ref);
    if (rawResult.kind === 'missing') {
      if (permit !== null && permit.rawStateDigest !== null) {
        return invalidResult(
          'malformed',
          'Read-only permit expected a state head that is missing.',
        );
      }
      return { kind: 'missing' };
    }
    if (rawResult.kind === 'malformed') return invalidResult('malformed', rawResult.message);
    const raw = rawResult.raw;
    if (permit !== null) {
      if (permit.rawStateDigest !== raw.digest) {
        return invalidResult(
          'malformed',
          'State bytes changed after the read-only permit was issued.',
        );
      }
    }
    const classification = classifyStateVersion(raw.value);
    if (classification.kind === 'malformed')
      return invalidResult('malformed', classification.message);
    if (classification.kind === 'future-version') {
      return invalidResult('future-version', classification.message);
    }
    if (permit !== null) {
      return invalidResult(
        'malformed',
        'A read-only resume permit cannot authorize migration or loading a valid state.',
      );
    }
    if (authority.kind !== 'fenced') {
      return invalidResult('malformed', 'Resume loading requires a usable fenced authority.');
    }
    const receipt = authority.receipt;

    if (classification.kind === 'v4') {
      const current = classification.state;
      if (current.stateFence === undefined) {
        return invalidResult('malformed', 'Current v4 state has no persisted fence.');
      }
      if (receipt.stateDigest !== raw.digest) {
        return invalidResult(
          'malformed',
          'State authority receipt digest does not match the current v4 state.',
        );
      }
      if (receipt.stateRevision !== current.stateRevision) {
        return invalidResult(
          'malformed',
          'State authority receipt revision does not match the current v4 state.',
        );
      }
      if (
        receipt.fence !== current.stateFence.token ||
        receipt.ownerId !== current.stateFence.ownerId
      ) {
        return invalidResult(
          'malformed',
          'State authority receipt fence does not match the current v4 state.',
        );
      }
      cacheRawState(statePath(input.ref), raw, current);
      return { kind: 'loaded', state: current, migrated: authority.promotedFromVersion === 3 };
    }

    const migrated = migrateV3WithReceipt(input.ref, raw, classification.state, authority.receipt);
    if (migrated.kind === 'conflict') {
      throw statePersistenceError.conflict(migrated.message, migrated);
    }
    if (migrated.kind === 'durability-uncertain') {
      throw statePersistenceError.durabilityUncertain(migrated.message, migrated);
    }
    if (migrated.kind !== 'fenced') {
      throw statePersistenceError.authority('v3 migration did not produce a usable receipt.');
    }
    const finalRead = readRawState(input.ref);
    if (finalRead.kind !== 'present') {
      throw statePersistenceError.durabilityUncertain(
        'v3 migration committed but the resulting state cannot be read.',
      );
    }
    const finalClassification = classifyStateVersion(finalRead.raw.value);
    if (finalClassification.kind !== 'v4') {
      throw statePersistenceError.durabilityUncertain(
        'v3 migration committed a state that is not a valid v4 snapshot.',
      );
    }
    cacheRawState(statePath(input.ref), finalRead.raw, finalClassification.state);
    return { kind: 'loaded', state: finalClassification.state, migrated: true };
  } finally {
    if (permit !== null) consumedReadOnlyPermits.add(permitKey(permit));
  }
}
