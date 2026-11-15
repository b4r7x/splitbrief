import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type {
  EvidenceLedger,
  EvidencePromotedFile,
  EvidenceTask,
} from '../../../core/schemas/evidence.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { loadState } from '../../../core/state/persistence.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import type { SessionRef } from '../../../core/types/session-ref.js';

export function provenCreatedPaths(
  entry: EvidenceTask | undefined,
  workspacePath?: string | undefined,
): string[] {
  const receipt = entry?.apiApply;
  if (receipt?.workspacePath !== undefined && receipt.workspacePath !== workspacePath) return [];
  const reverted = new Set(receipt?.revertedPaths ?? []);
  const paths = new Set((entry?.apiCreatedPaths ?? []).filter((path) => !reverted.has(path)));
  for (const file of receipt?.applied ?? []) {
    if (file.action === 'create' && file.beforeSha256 === null && !reverted.has(file.path))
      paths.add(file.path);
  }
  return [...paths];
}

/** The ids of a brief's lineage: the brief, its split siblings and the parents the lineage replaced. */
function lineageBriefIds(state: WorkflowState | null, task: Task): Set<TaskId> {
  const lineage = lineageIdOf(task);
  const siblings = (state?.tasks ?? []).filter((brief) => lineageIdOf(brief) === lineage);
  const parents = state?.lineages?.[lineage]?.replacedParents ?? [];
  return new Set([task, ...siblings, ...parents].map((brief) => brief.id));
}

/**
 * A missing or unreadable receipt proves no ownership, so capture remains fail-closed. A receipt
 * written in the run workspace proves what the task's lineage created there: the task itself, a
 * split parent the lineage replaced, or a sibling of its split. A brief keeps `create` for every
 * file its lineage created (`lineageAnchorAction`).
 */
export function recordedApiCreatedPaths(
  ref: SessionRef,
  task: Task,
  workspacePath: string,
): string[] {
  try {
    const ids = lineageBriefIds(loadState(ref), task);
    const entries = readEvidenceLedger(ref)?.tasks.filter((entry) => ids.has(entry.id)) ?? [];
    return [...new Set(entries.flatMap((entry) => provenCreatedPaths(entry, workspacePath)))];
  } catch {
    return [];
  }
}

/** Historical receipts can establish prior output, but cannot prove its current contents. */
export function recordedTargetOutput(
  ref: SessionRef,
  task: Task,
): { files: EvidencePromotedFile[]; hasOutput: boolean } {
  try {
    const entry = readEvidenceLedger(ref)?.tasks.find((entry) => entry.id === task.id);
    const hasOutput =
      entry?.promotedBriefHash !== undefined ||
      (entry?.promotedFiles?.length ?? 0) > 0 ||
      (entry?.promotionAttempts ?? []).some((attempt) => attempt.appliedFiles.length > 0) ||
      (entry?.apiApply?.workspacePath === undefined && (entry?.apiApply?.applied.length ?? 0) > 0);
    return {
      files: entry?.promotedBriefHash === hashTaskBrief([task]) ? (entry.promotedFiles ?? []) : [],
      hasOutput,
    };
  } catch {
    return { files: [], hasOutput: false };
  }
}

/** One current owner per path across every task and every target-write path. */
export function withTargetWrites(input: {
  ledger: EvidenceLedger;
  task: Task;
  files: EvidencePromotedFile[];
  unknownPaths?: string[] | undefined;
}): EvidenceLedger {
  const { ledger, task, files, unknownPaths = [] } = input;
  if (files.length === 0 && unknownPaths.length === 0) return ledger;
  const hash = hashTaskBrief([task]);
  const latest = [...new Map(files.map((file) => [file.path, file])).values()];
  const replaced = new Set([...latest.map((file) => file.path), ...unknownPaths]);
  return {
    ...ledger,
    tasks: ledger.tasks.map((entry) => {
      if (entry.id === task.id) {
        const previous = entry.promotedBriefHash === hash ? (entry.promotedFiles ?? []) : [];
        const created = provenCreatedPaths(entry);
        return {
          ...entry,
          promotedBriefHash: hash,
          promotedFiles: [...previous.filter((file) => !replaced.has(file.path)), ...latest],
          ...(created.length > 0 ? { apiCreatedPaths: created } : {}),
        };
      }
      if (entry.promotedFiles === undefined) return entry;
      return {
        ...entry,
        promotedFiles: entry.promotedFiles.filter((file) => !replaced.has(file.path)),
      };
    }),
  };
}
