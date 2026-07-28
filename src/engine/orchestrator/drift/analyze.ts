import type { Task } from '../../../core/schemas/task.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { DriftFinding, DriftReport } from '../../../core/schemas/drift.js';
import { uniqueInOrder } from '../../../utils/collections.js';
import { clamp01 } from '../../../utils/math.js';
import { matchesActionPattern } from '../approval/action-classifier.js';

export type AnalyzeBriefDriftInput = {
  tasks: Task[];
  changedFiles: string[];
  diff: string;
  ledger?: EvidenceLedger | null | undefined;
  briefHash?: string | null;
  preRunChangedFiles?: string[] | null | undefined;
};

function isFailedOrSkipped(status: Task['status']): boolean {
  return status === 'failed' || status === 'skipped';
}

export function analyzeBriefDrift(input: AnalyzeBriefDriftInput): DriftReport {
  const findings: DriftFinding[] = [];
  const expectedFiles = uniqueInOrder(input.tasks.map((task) => task.file).filter(Boolean)).sort();
  const acceptedPatterns = input.tasks.flatMap((task) => [
    task.file,
    ...(task.scope?.inBounds ?? []),
    ...(task.scope?.approvedOutOfBounds ?? []),
  ]);
  const changedFiles = uniqueInOrder(input.changedFiles).sort();

  // Files attributed to task execution by the evidence ledger. Legacy states
  // without a run-start baseline use this as their only provenance signal.
  const runAttributed = new Set<string>();
  if (input.ledger) {
    for (const entry of input.ledger.tasks) {
      for (const file of entry.changedFiles) runAttributed.add(file);
    }
  }
  // Files already dirty at run-start (the run-start status baseline). Under the
  // `none` commit strategy the working-tree universe over-includes these, so a
  // pre-run-dirty file the run never touched must be annotated "pre-existing"
  // rather than attributed to this run. The ledger overrides a baseline file
  // the run did touch. Legacy states without a baseline fall back to treating
  // files absent from the ledger as pre-existing.
  const preRunBaseline = new Set(input.preRunChangedFiles ?? []);
  const hasPreRunBaseline = input.preRunChangedFiles != null;
  const isPreExisting = (file: string): boolean => {
    if (runAttributed.has(file)) return false;
    return hasPreRunBaseline ? preRunBaseline.has(file) : input.ledger != null;
  };

  const outOfBoundsPatterns: string[] = [];
  for (const task of input.tasks) {
    for (const p of task.scope?.outOfBounds ?? []) {
      if (p) outOfBoundsPatterns.push(p);
    }
  }
  const hasExplicitOutOfBounds = outOfBoundsPatterns.length > 0;

  for (const pattern of outOfBoundsPatterns) {
    const fileHit = changedFiles.find((f) => f.includes(pattern));
    if (fileHit) {
      findings.push({
        severity: 'error',
        code: 'out_of_bounds_text_match',
        file: fileHit,
        message: `Out-of-bounds pattern "${pattern}" matched changed file ${fileHit}.`,
      });
      continue;
    }
    if (input.diff.includes(pattern)) {
      findings.push({
        severity: 'error',
        code: 'out_of_bounds_text_match',
        message: `Out-of-bounds pattern "${pattern}" appears in diff.`,
      });
    }
  }

  for (const file of changedFiles) {
    if (acceptedPatterns.some((pattern) => matchesActionPattern(file, pattern))) continue;
    if (isPreExisting(file)) {
      findings.push({
        severity: 'info',
        code: 'out_of_scope_file',
        file,
        message: `${file} was changed before this run started (pre-existing, not attributed to this run).`,
      });
      continue;
    }
    findings.push({
      severity: hasExplicitOutOfBounds ? 'error' : 'warning',
      code: 'out_of_scope_file',
      file,
      message: `${file} was changed but no Task Brief targets it.`,
    });
  }

  for (const task of input.tasks) {
    if (
      isTaskCompleted(task.status) &&
      task.file &&
      !changedFiles.some((file) => matchesActionPattern(file, task.file))
    ) {
      findings.push({
        severity: 'warning',
        code: 'missing_expected_file',
        taskId: task.id,
        file: task.file,
        message: `Task ${task.id} reached ${task.status} but ${task.file} was not changed.`,
      });
    }
  }

  for (const task of input.tasks) {
    if (
      task.status === 'failed' &&
      task.file &&
      changedFiles.some((file) => matchesActionPattern(file, task.file))
    ) {
      findings.push({
        severity: 'error',
        code: 'failed_task_with_diff',
        taskId: task.id,
        file: task.file,
        message: `Failed task ${task.id} left changes in ${task.file}.`,
      });
    }
  }

  // Pre-run-dirty files were not produced by this run, so they cannot be an
  // orphan diff.
  const runProducedFiles = changedFiles.filter((file) => !isPreExisting(file));
  if (
    runProducedFiles.length > 0 &&
    input.tasks.length > 0 &&
    input.tasks.every((t) => isFailedOrSkipped(t.status))
  ) {
    findings.push({
      severity: 'error',
      code: 'orphan_diff',
      message: `Diff contains ${runProducedFiles.length} file(s) but every task is failed or skipped.`,
    });
  }

  if (input.ledger) {
    for (const entry of input.ledger.tasks) {
      if (!isTaskCompleted(entry.status)) continue;
      if (entry.expectedEvidence.length === 0) continue;
      if (entry.observedEvidence.length === 0) {
        findings.push({
          severity: 'warning',
          code: 'missing_evidence',
          taskId: entry.id,
          message: `Task ${entry.id} expected evidence but none was observed.`,
        });
      }
    }
  }

  let score = 1;
  let errorCount = 0;
  for (const f of findings) {
    if (f.severity === 'error') {
      score -= 0.25;
      errorCount += 1;
    } else if (f.severity === 'warning') {
      score -= 0.08;
    }
  }
  score = clamp01(score);

  return {
    version: 1,
    passed: errorCount === 0,
    score,
    changedFiles,
    expectedFiles,
    findings,
    briefHash: input.briefHash ?? null,
  };
}
