import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
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

export function evidenceLedgerPath(projectDir: string, sessionId: string): string {
  return join(sessionDir(projectDir, sessionId), EVIDENCE_FILE);
}

const LEDGER_LOCK_SUFFIX = '.lock';
const LEDGER_LOCK_MAX_ATTEMPTS = 100;
const LEDGER_LOCK_SPIN_MS = 5;

function evidenceLedgerLockPath(ledgerPath: string): string {
  return `${ledgerPath}${LEDGER_LOCK_SUFFIX}`;
}

function acquireEvidenceLedgerLock(lockPath: string): void {
  ensureSecureDir(dirname(lockPath));
  for (let attempt = 0; attempt < LEDGER_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      return;
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code !== 'EEXIST') throw err;
      const deadline = Date.now() + LEDGER_LOCK_SPIN_MS;
      while (Date.now() < deadline) {
        // spin until retry or timeout slice elapses
      }
    }
  }
  throw new Error(`timed out acquiring evidence ledger lock: ${lockPath}`);
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

export function writeEvidenceLedger(
  projectDir: string,
  sessionId: string,
  ledger: EvidenceLedger,
): void {
  const ledgerPath = evidenceLedgerPath(projectDir, sessionId);
  withEvidenceLedgerLock(ledgerPath, () => {
    writeEvidenceLedgerUnlocked(ledgerPath, ledger);
  });
}

export function mutateEvidenceLedger(
  projectDir: string,
  sessionId: string,
  mutate: (ledger: EvidenceLedger | null) => EvidenceLedger,
): EvidenceLedger {
  const ledgerPath = evidenceLedgerPath(projectDir, sessionId);
  return withEvidenceLedgerLock(ledgerPath, () => {
    const current = readEvidenceLedger(projectDir, sessionId);
    const updated = mutate(current);
    writeEvidenceLedgerUnlocked(ledgerPath, updated);
    return updated;
  });
}

export function readEvidenceLedger(projectDir: string, sessionId: string): EvidenceLedger | null {
  const raw = readJsonSafe(evidenceLedgerPath(projectDir, sessionId));
  if (raw === null) return null;
  const result = EvidenceLedgerSchema.safeParse(raw);
  return result.success ? result.data : null;
}
