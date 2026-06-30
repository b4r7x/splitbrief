import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Task } from '../schemas/task.js';
import type { WorkflowMode } from '../schemas/enums.js';
import type {
  EvidenceLedger,
  EvidenceTask,
  EvidenceApproval,
  EvidenceRejection,
} from '../schemas/evidence.js';
import { EvidenceLedgerSchema } from '../schemas/evidence.js';
import { EVIDENCE_FILE, sessionDir } from '../paths.js';
import { ensureSecureDir, readJsonSafe, writeSecureFile } from '../../lib/fs.js';
import { nowIso } from '../../utils/format-time.js';
import { evidenceError } from './errors.js';
import type { SessionRef } from '../types/session-ref.js';

function buildExpectedEvidence(task: Task): string[] {
  const out: string[] = [];
  for (const e of task.evidence ?? []) out.push(e);
  for (const t of task.tests ?? []) out.push(t);
  return out;
}

export function emptyEvidenceTask(task: Task): EvidenceTask {
  return {
    id: task.id,
    title: task.title,
    file: task.file,
    status: task.status,
    retries: 0,
    changedFiles: [],
    validation: [],
    expectedEvidence: buildExpectedEvidence(task),
    observedEvidence: [],
    escalated: false,
    briefHash: null,
  };
}

export function recomputeValidationSummary(
  tasks: EvidenceTask[],
): EvidenceLedger['validationSummary'] {
  const summary = { passed: 0, failed: 0, skipped: 0, escalated: 0 };
  for (const t of tasks) {
    if (t.status === 'skipped') {
      summary.skipped += 1;
      continue;
    }
    if (t.status === 'escalated') {
      summary.escalated += 1;
    }
    if (t.status === 'done') {
      summary.passed += 1;
      continue;
    }
    if (t.status === 'failed') {
      summary.failed += 1;
    }
  }
  return summary;
}

export function withUpdatedTask(
  ledger: EvidenceLedger,
  taskId: string,
  updater: (task: EvidenceTask) => EvidenceTask,
): EvidenceLedger {
  const tasks = ledger.tasks.map((t) => (t.id === taskId ? updater({ ...t }) : t));
  return {
    ...ledger,
    tasks,
    validationSummary: recomputeValidationSummary(tasks),
    generatedAt: nowIso(),
  };
}

export function withAppendedApproval(
  ledger: EvidenceLedger,
  entry: EvidenceApproval,
): EvidenceLedger {
  return { ...ledger, approvals: [...(ledger.approvals ?? []), entry], generatedAt: nowIso() };
}

export function withAppendedRejection(
  ledger: EvidenceLedger,
  entry: EvidenceRejection,
): EvidenceLedger {
  return { ...ledger, rejections: [...(ledger.rejections ?? []), entry], generatedAt: nowIso() };
}

export function findOrSeed(
  ledger: EvidenceLedger,
  task: Task,
  briefHash?: string | null,
): EvidenceTask {
  const existing = ledger.tasks.find((t) => t.id === task.id);
  if (existing) {
    const resolvedHash = existing.briefHash != null ? existing.briefHash : (briefHash ?? null);
    return {
      ...existing,
      title: task.title,
      file: task.file,
      changedFiles: [...existing.changedFiles],
      validation: existing.validation.map((v) => ({
        ...v,
        ...(v.changedFiles ? { changedFiles: [...v.changedFiles] } : {}),
      })),
      expectedEvidence:
        existing.expectedEvidence.length > 0
          ? [...existing.expectedEvidence]
          : buildExpectedEvidence(task),
      observedEvidence: [...existing.observedEvidence],
      briefHash: resolvedHash,
    };
  }
  return emptyEvidenceTask(task);
}

export type CreateEvidenceLedgerInput = {
  sessionId: string;
  feature: string;
  mode?: WorkflowMode | undefined;
  tasks: Task[];
  briefHash?: string | null;
};

export function createEvidenceLedger(input: CreateEvidenceLedgerInput): EvidenceLedger {
  const bh = input.briefHash ?? null;
  const tasks = input.tasks.map((task) => ({ ...emptyEvidenceTask(task), briefHash: bh }));
  const ledger: EvidenceLedger = {
    version: 1,
    sessionId: input.sessionId,
    feature: input.feature,
    generatedAt: nowIso(),
    tasks,
    validationSummary: recomputeValidationSummary(tasks),
    briefHash: bh,
  };
  if (input.mode !== undefined) ledger.mode = input.mode;
  return ledger;
}

export function getOrCreateLedger(
  input: CreateEvidenceLedgerInput,
  existing: EvidenceLedger | null,
): EvidenceLedger {
  return existing ?? createEvidenceLedger(input);
}

export function evidenceLedgerPath(ref: SessionRef): string {
  return join(sessionDir(ref.projectDir, ref.sessionId), EVIDENCE_FILE);
}

const LEDGER_LOCK_SUFFIX = '.lock';
const LEDGER_LOCK_MAX_ATTEMPTS = 100;
const LEDGER_LOCK_SLEEP_MS = 5;
const LEDGER_LOCK_STALE_MS = 30_000;

type LedgerLockHolder = { pid: number; acquiredAt: number };

function evidenceLedgerLockPath(ledgerPath: string): string {
  return `${ledgerPath}${LEDGER_LOCK_SUFFIX}`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    return code === 'EPERM';
  }
}

function readLockHolder(lockPath: string): LedgerLockHolder | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { pid, acquiredAt } = parsed as { pid?: unknown; acquiredAt?: unknown };
  if (typeof pid !== 'number' || typeof acquiredAt !== 'number') return null;
  return { pid, acquiredAt };
}

function lockIsStale(lockPath: string): boolean {
  const holder = readLockHolder(lockPath);
  if (holder === null) return true;
  if (!isPidAlive(holder.pid)) return true;
  return Date.now() - holder.acquiredAt > LEDGER_LOCK_STALE_MS;
}

function acquireEvidenceLedgerLock(lockPath: string): void {
  ensureSecureDir(dirname(lockPath));
  for (let attempt = 0; attempt < LEDGER_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        const holder: LedgerLockHolder = { pid: process.pid, acquiredAt: Date.now() };
        writeSync(fd, JSON.stringify(holder));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code !== 'EEXIST') throw err;
      if (lockIsStale(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // another holder reclaimed or refreshed the lock; retry the acquire loop
        }
        continue;
      }
      sleepSync(LEDGER_LOCK_SLEEP_MS);
    }
  }
  throw evidenceError.lockTimeout(lockPath);
}

function releaseEvidenceLedgerLock(lockPath: string): void {
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    // best-effort unlock
  }
}

function withEvidenceLedgerLock<T>(ledgerPath: string, fn: () => T): T {
  const lockPath = evidenceLedgerLockPath(ledgerPath);
  acquireEvidenceLedgerLock(lockPath);
  try {
    return fn();
  } finally {
    releaseEvidenceLedgerLock(lockPath);
  }
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
