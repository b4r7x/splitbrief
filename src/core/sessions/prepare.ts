import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confinedEnsureDir } from '../../lib/fs/confined.js';
import { SECURE_DIR_MODE, SECURE_FILE_MODE, writeSecureFile } from '../../lib/fs/secure.js';
import { assertWritablePathConfined } from '../../lib/fs/confinement.js';
import { hasErrnoCode } from '../../utils/errno.js';
import { isRecord } from '../../utils/type-guards.js';
import type { DeepReadonly } from '../config/accessors/runner-config.js';
import { READINESS_FILE, sessionDir, SESSIONS_DIR, SPLITBRIEF_DIR } from '../paths.js';
import { createStartReadinessRecord } from '../readiness/format.js';
import type { ReadinessReport } from '../readiness/types.js';
import type { Config } from '../schemas/config.js';
import type { SessionRef } from '../types/session-ref.js';
import {
  assertSessionOwnershipReceipt,
  withSessionMutationLock,
  writeActiveReceiptLocked,
  type ActiveSessionReceipt,
  type NewSessionOwnership,
  type PreparedNewSession,
  type SessionOwnershipReceipt,
} from './active-pointer.js';
import { sessionPreparationError } from './errors.js';
import { generateSessionId } from './id.js';
import {
  assertOwnedDirectory,
  assertOwnershipContext,
  claimRelativePath,
  directoryIdentity,
  ownershipFailure,
  ownershipRelativePath,
  pathExists,
  removeOwnershipProofLocked,
  sessionRelativePath,
  OWNERSHIP_FILE,
  type SessionDirectoryIdentity,
  type SessionOwnershipProof,
} from './ownership-marker.js';
import { rollbackPreparedSessionLocked } from './prepared-rollback.js';

export type SessionMutationBoundary = 'allocation' | 'readiness' | 'active';

export type PrepareNewSessionInput = Readonly<{
  projectDir: string;
  feature: string;
  config: DeepReadonly<Config>;
  report: ReadinessReport;
  signal?: AbortSignal | undefined;
  candidate?: SessionOwnershipReceipt | undefined;
  publishDefault?: boolean | undefined;
  _beforeMutation?: ((boundary: SessionMutationBoundary) => void) | undefined;
}>;

export type PrepareNewSessionResult =
  | Readonly<{ kind: 'prepared'; session: PreparedNewSession }>
  | Readonly<{ kind: 'aborted' }>;

function abortBefore(input: PrepareNewSessionInput, boundary: SessionMutationBoundary): boolean {
  input._beforeMutation?.(boundary);
  return input.signal?.aborted === true;
}

function removeAllocatedDirectory(ref: SessionRef, identity: SessionDirectoryIdentity): void {
  const original = sessionRelativePath(ref.sessionId);
  directoryIdentity(ref, original, identity);
  const claim = claimRelativePath(ref, 'directory');
  const originalPath = join(ref.projectDir, original);
  const claimPath = join(ref.projectDir, claim);
  assertWritablePathConfined(original, ref.projectDir);
  assertWritablePathConfined(claim, ref.projectDir);
  renameSync(originalPath, claimPath);
  directoryIdentity(ref, claim, identity);
  if (pathExists(originalPath)) {
    throw ownershipFailure(ref, 'the canonical session path was recreated');
  }
  rmSync(claimPath, { recursive: true });
}

export function createSessionPreparationCandidate(
  input: Readonly<{
    projectDir: string;
    feature: string;
    sessionId?: string | undefined;
  }>,
): SessionOwnershipReceipt {
  const receipt: SessionOwnershipReceipt = {
    version: 1,
    sessionId:
      input.sessionId ??
      generateSessionId({ projectDir: input.projectDir, feature: input.feature }),
    generation: randomUUID(),
  };
  assertSessionOwnershipReceipt(receipt);
  return receipt;
}

function cleanupAfterReadinessFailure(session: NewSessionOwnership, keepDirectory: boolean): void {
  withSessionMutationLock(session.ref.projectDir, () => {
    if (keepDirectory) removeOwnershipProofLocked(session);
    else rollbackPreparedSessionLocked(session);
  });
}

function allocateSession(input: PrepareNewSessionInput): {
  owned: NewSessionOwnership;
  identity: SessionDirectoryIdentity;
} {
  const { projectDir } = input;
  return withSessionMutationLock(projectDir, () => {
    const ownership = input.candidate ?? createSessionPreparationCandidate(input);
    const ref = { projectDir, sessionId: ownership.sessionId };
    const owned = { ref, ownership };
    assertOwnershipContext(owned);
    let identity: SessionDirectoryIdentity | undefined;
    try {
      confinedEnsureDir(projectDir, join(SPLITBRIEF_DIR, SESSIONS_DIR));
      const relativeDirectory = sessionRelativePath(ref.sessionId);
      assertWritablePathConfined(relativeDirectory, projectDir);
      const directory = sessionDir(projectDir, ref.sessionId);
      mkdirSync(directory, { mode: SECURE_DIR_MODE });
      identity = directoryIdentity(ref, relativeDirectory);
      const proof: SessionOwnershipProof = {
        ...ownership,
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
      };
      assertWritablePathConfined(ownershipRelativePath(relativeDirectory), projectDir);
      writeFileSync(join(directory, OWNERSHIP_FILE), `${JSON.stringify(proof)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: SECURE_FILE_MODE,
      });
      assertOwnedDirectory(owned, relativeDirectory, identity);
      return { owned, identity };
    } catch (cause) {
      if (identity !== undefined) {
        try {
          removeAllocatedDirectory(ref, identity);
        } catch (cleanupCause) {
          throw sessionPreparationError.io('allocate-session', ref, cleanupCause);
        }
      }
      throw sessionPreparationError.io('allocate-session', ref, cause);
    }
  });
}

export function prepareNewSession(input: PrepareNewSessionInput): PrepareNewSessionResult {
  if (abortBefore(input, 'allocation')) return { kind: 'aborted' };
  const { owned, identity } = allocateSession(input);
  const { ref, ownership } = owned;

  if (abortBefore(input, 'readiness')) {
    try {
      withSessionMutationLock(ref.projectDir, () => rollbackPreparedSessionLocked(owned));
    } catch (cause) {
      throw sessionPreparationError.io('rollback-session', ref, cause);
    }
    return { kind: 'aborted' };
  }

  let linkError: unknown;
  let temporaryCleanupError: unknown;
  try {
    const relativeDirectory = sessionRelativePath(ref.sessionId);
    assertOwnedDirectory(owned, relativeDirectory, identity);
    const directory = sessionDir(ref.projectDir, ref.sessionId);
    const target = join(directory, READINESS_FILE);
    const temporary = join(directory, `.${READINESS_FILE}.${randomUUID()}.tmp`);
    const record = createStartReadinessRecord(input.report, ref);
    assertWritablePathConfined(sessionRelativePath(ref.sessionId, READINESS_FILE), ref.projectDir);
    writeSecureFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    assertOwnedDirectory(owned, relativeDirectory, identity);
    try {
      linkSync(temporary, target);
    } catch (cause) {
      linkError = cause;
    } finally {
      try {
        rmSync(temporary, { force: true });
      } catch (cause) {
        temporaryCleanupError = cause;
      }
    }
    if (linkError) throw linkError;
    if (temporaryCleanupError) throw temporaryCleanupError;
  } catch (cause) {
    const keepDirectory = hasErrnoCode(linkError, 'EEXIST');
    try {
      cleanupAfterReadinessFailure(owned, keepDirectory);
    } catch (cleanupCause) {
      throw sessionPreparationError.io('write-readiness', ref, cleanupCause);
    }
    throw sessionPreparationError.io('write-readiness', ref, cause);
  }

  try {
    return withSessionMutationLock(ref.projectDir, () => {
      try {
        input._beforeMutation?.('active');
        assertOwnedDirectory(owned, sessionRelativePath(ref.sessionId), identity);
        if (input.signal?.aborted === true) {
          rollbackPreparedSessionLocked(owned);
          return { kind: 'aborted' };
        }
        const active: ActiveSessionReceipt = ownership;
        if (input.publishDefault !== false) writeActiveReceiptLocked(ref, active);
        return { kind: 'prepared', session: { ...owned, active } };
      } catch (cause) {
        try {
          rollbackPreparedSessionLocked(owned);
        } catch (cleanupCause) {
          throw sessionPreparationError.io('publish-active', ref, cleanupCause);
        }
        throw cause;
      }
    });
  } catch (cause) {
    if (
      isRecord(cause) &&
      cause.kind === 'session-prepare-io' &&
      isRecord(cause.data) &&
      cause.data.operation === 'publish-active'
    ) {
      throw cause;
    }
    throw sessionPreparationError.io('publish-active', ref, cause);
  }
}
