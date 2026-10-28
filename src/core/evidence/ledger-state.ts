import type { Task } from '../schemas/task.js';
import type {
  EvidenceLedger,
  EvidenceTask,
  EvidenceApproval,
  EvidenceRejection,
  EvidenceCommandRun,
  EvidenceCheckEntry,
} from '../schemas/evidence.js';
import { nowIso } from '../../utils/format-time.js';
import { hashTaskBrief } from './brief-hash.js';

export function emptyEvidenceTask(task: Task): EvidenceTask {
  return {
    id: task.id,
    title: task.title,
    file: task.suggestedFiles[0],
    status: task.status,
    retries: 0,
    changedFiles: [],
    checks: [],
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

/**
 * Writes one task into the ledger by id: a task the ledger already knows is replaced, and a task
 * appended after the ledger was created — a fix brief — is added rather than dropped.
 */
export function upsertEvidenceTask(ledger: EvidenceLedger, task: EvidenceTask): EvidenceLedger {
  const known = ledger.tasks.some((t) => t.id === task.id);
  const tasks = known
    ? ledger.tasks.map((t) => (t.id === task.id ? task : t))
    : [...ledger.tasks, task];
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

export function withAppendedVerifyChecks(
  ledger: EvidenceLedger,
  entries: readonly EvidenceCheckEntry[],
): EvidenceLedger {
  return {
    ...ledger,
    verifyChecks: [...(ledger.verifyChecks ?? []), ...entries],
    generatedAt: nowIso(),
  };
}

/** Keeps the newest run of a command per tree: a run on a newer tree state replaces the older one. */
export function withCommandRun(ledger: EvidenceLedger, run: EvidenceCommandRun): EvidenceLedger {
  const others = (ledger.commandRuns ?? []).filter(
    (entry) => entry.tree !== run.tree || entry.command !== run.command,
  );
  return { ...ledger, commandRuns: [...others, run], generatedAt: nowIso() };
}

/** The entry that records work on this brief, stamped with the hash of the brief as it is now. */
export function findOrSeed(ledger: EvidenceLedger, task: Task): EvidenceTask {
  const briefHash = hashTaskBrief([task]);
  const existing = ledger.tasks.find((t) => t.id === task.id);
  if (existing) {
    return {
      ...existing,
      title: task.title,
      file: task.suggestedFiles[0],
      changedFiles: [...existing.changedFiles],
      checks: (existing.checks ?? []).map((entry) =>
        entry.artifacts
          ? { ...entry, artifacts: entry.artifacts.map((artifact) => ({ ...artifact })) }
          : { ...entry },
      ),
      briefHash,
    };
  }
  return { ...emptyEvidenceTask(task), briefHash };
}

export type CreateEvidenceLedgerInput = {
  sessionId: string;
  feature: string;
  tasks: Task[];
  briefHash?: string | null;
};

export function createEvidenceLedger(input: CreateEvidenceLedgerInput): EvidenceLedger {
  const tasks = input.tasks.map(emptyEvidenceTask);
  const ledger: EvidenceLedger = {
    version: 1,
    sessionId: input.sessionId,
    feature: input.feature,
    generatedAt: nowIso(),
    tasks,
    validationSummary: recomputeValidationSummary(tasks),
    briefHash: input.briefHash ?? null,
  };
  return ledger;
}

export function getOrCreateLedger(
  input: CreateEvidenceLedgerInput,
  existing: EvidenceLedger | null,
): EvidenceLedger {
  return existing ?? createEvidenceLedger(input);
}
