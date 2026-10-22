import type { Task } from '../../../core/schemas/task.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { DriftFinding, DriftReport } from '../../../core/schemas/drift.js';
import {
  PLAN_FILE,
  RESEARCH_FILE,
  REVIEW_FILE,
  SPEC_FILE,
  TASKS_FILE,
} from '../../../core/paths.js';
import { uniqueInOrder } from '../../../utils/collections.js';
import { isInDeclaredSet, taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import { countNoun } from '../../../utils/pluralize.js';

export type AnalyzeBriefDriftInput = {
  tasks: Task[];
  changedFiles: string[];
  ledger?: EvidenceLedger | null | undefined;
  briefHash?: string | null;
  preRunChangedFiles: readonly string[];
};

function isFailedOrSkipped(status: Task['status']): boolean {
  return status === 'failed' || status === 'skipped';
}

// Root-level planner phase outputs. The planner writes these into the project
// during planning, so they are the session's own artifacts: their presence in
// the diff is orchestration, not implementer drift — unless a Task Brief
// explicitly targets one of them.
const SESSION_ARTIFACT_FILES: ReadonlySet<string> = new Set([
  RESEARCH_FILE,
  SPEC_FILE,
  PLAN_FILE,
  TASKS_FILE,
  REVIEW_FILE,
]);

export function analyzeBriefDrift(input: AnalyzeBriefDriftInput): DriftReport {
  const findings: DriftFinding[] = [];
  const expectedFiles = uniqueInOrder(
    input.tasks.flatMap((task) => [...task.suggestedFiles]).filter(Boolean),
  ).sort();
  const acceptedPatterns = input.tasks.flatMap((task) => [...taskDeclaredPatterns(task)]);
  const isSessionArtifact = (file: string): boolean =>
    SESSION_ARTIFACT_FILES.has(file) && !isInDeclaredSet(file, acceptedPatterns);
  const changedFiles = uniqueInOrder(input.changedFiles)
    .filter((file) => !isSessionArtifact(file))
    .sort();

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
  // the run did touch.
  const preRunBaseline = new Set(input.preRunChangedFiles);
  const isPreExisting = (file: string): boolean =>
    !runAttributed.has(file) && preRunBaseline.has(file);

  for (const file of changedFiles) {
    if (isInDeclaredSet(file, acceptedPatterns)) continue;
    if (isPreExisting(file)) {
      findings.push({
        severity: 'info',
        code: 'out_of_scope_file',
        file,
        message: `${file} was changed before this run started (pre-existing, not attributed to this run).`,
      });
      continue;
    }
    // A brief's files are suggestions: an unplanned file is recorded for the reviewer, never failed.
    findings.push({
      severity: 'info',
      code: 'out_of_scope_file',
      file,
      message: `${file} touched, not suggested by any task.`,
    });
  }

  for (const task of input.tasks) {
    if (
      isTaskCompleted(task.status) &&
      task.suggestedFiles[0] &&
      !changedFiles.some((file) => isInDeclaredSet(file, task.suggestedFiles))
    ) {
      findings.push({
        severity: 'warning',
        code: 'missing_expected_file',
        taskId: task.id,
        message: `Task ${task.id} reached ${task.status} but ${task.suggestedFiles.join(', ')} ${task.suggestedFiles.length === 1 ? 'was' : 'were'} not changed.`,
      });
    }
  }

  for (const task of input.tasks) {
    const left =
      task.status === 'failed'
        ? changedFiles.filter((file) => isInDeclaredSet(file, task.suggestedFiles))
        : [];
    if (left.length > 0) {
      findings.push({
        severity: 'error',
        code: 'failed_task_with_diff',
        taskId: task.id,
        message: `Failed task ${task.id} left changes in ${left.join(', ')}.`,
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
      message: `Diff contains ${countNoun(runProducedFiles.length, 'file')} but every task is failed or skipped.`,
    });
  }

  return {
    version: 1,
    passed: !findings.some((finding) => finding.severity === 'error'),
    changedFiles,
    expectedFiles,
    findings,
    briefHash: input.briefHash ?? null,
  };
}
