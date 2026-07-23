import { join } from 'node:path';
import type { EvidenceLedger } from '../schemas/evidence.js';
import { EvidenceLedgerSchema } from '../schemas/evidence.js';
import { EVIDENCE_FILE, sessionDir } from '../paths.js';
import { readJsonSafe, writeSecureFile } from '../../lib/fs.js';
import { lockSibling, withFileLock } from '../../lib/file-lock.js';
import { evidenceError } from './errors.js';
import type { SessionRef } from '../types/session-ref.js';

export function evidenceLedgerPath(ref: SessionRef): string {
  return join(sessionDir(ref.projectDir, ref.sessionId), EVIDENCE_FILE);
}

function withEvidenceLedgerLock<T>(ledgerPath: string, fn: () => T): T {
  const lockPath = lockSibling(ledgerPath);
  return withFileLock(lockPath, () => evidenceError.lockTimeout(lockPath), fn);
}

function writeEvidenceLedgerUnlocked(ledgerPath: string, ledger: EvidenceLedger): void {
  writeSecureFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

export function writeEvidenceLedger(ref: SessionRef, ledger: EvidenceLedger): void {
  const ledgerPath = evidenceLedgerPath(ref);
  withEvidenceLedgerLock(ledgerPath, () => {
    writeEvidenceLedgerUnlocked(ledgerPath, ledger);
  });
}

export function mutateEvidenceLedger(
  ref: SessionRef,
  mutate: (ledger: EvidenceLedger | null) => EvidenceLedger,
): EvidenceLedger {
  const ledgerPath = evidenceLedgerPath(ref);
  return withEvidenceLedgerLock(ledgerPath, () => {
    const current = readEvidenceLedger(ref);
    const updated = mutate(current);
    writeEvidenceLedgerUnlocked(ledgerPath, updated);
    return updated;
  });
}

export function readEvidenceLedger(ref: SessionRef): EvidenceLedger | null {
  const raw = readJsonSafe(evidenceLedgerPath(ref));
  if (raw === null) return null;
  const result = EvidenceLedgerSchema.safeParse(raw);
  return result.success ? result.data : null;
}
