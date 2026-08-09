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
import { clamp01 } from '../../../utils/math.js';
import { matchesActionPattern } from '../approval/action-classifier.js';
import { taskAcceptedPatterns } from '../task-scope.js';

export type AnalyzeBriefDriftInput = {
  tasks: Task[];
  changedFiles: string[];
  diff: string;
  ledger?: EvidenceLedger | null | undefined;
  briefHash?: string | null;
  preRunChangedFiles: readonly string[];
};

function isFailedOrSkipped(status: Task['status']): boolean {
  return status === 'failed' || status === 'skipped';
}

// Bookkeeping the orchestrator stamps on every completed task ('task reached
// done', 'diff written for …', 'final review written') would satisfy the
// missing-evidence check by construction — a gauge fed by its own stamps can
// never fire. Only validation outcomes and implementer-reported evidence
// count as observed.
const SELF_STAMPED_EVIDENCE =
  /^(?:task reached done$|task reached escalated$|diff written for |final review written$|skipped: )/;

function isInformativeEvidence(evidence: string): boolean {
  return !SELF_STAMPED_EVIDENCE.test(evidence);
}

// Root-level planner phase outputs. The planner writes these into the project
// during planning (see readCliPhaseOutput), so they are the session's own
// artifacts: their presence in the diff is orchestration, not implementer
// drift — unless a Task Brief explicitly targets one of them.
export const SESSION_ARTIFACT_FILES: ReadonlySet<string> = new Set([
  RESEARCH_FILE,
  SPEC_FILE,
  PLAN_FILE,
  TASKS_FILE,
  REVIEW_FILE,
]);

const DIFF_SECTION_HEADER = /^diff --git a\/(\S+) b\/(\S+)/;

// Strips session-artifact file sections from a unified diff so out-of-bounds
// content matching cannot hit the brief's own text (tasks.md quotes every
// out-of-bounds entry verbatim). Non-diff text passes through untouched.
function stripSessionArtifactDiffSections(diff: string): string {
  if (!diff.includes('diff --git ')) return diff;
  return diff
    .split(/^(?=diff --git )/m)
    .filter((section) => {
      const header = DIFF_SECTION_HEADER.exec(section);
      return header === null || !SESSION_ARTIFACT_FILES.has(header[2] ?? '');
    })
    .join('');
}

type OutOfBoundsPatternKind = 'path' | 'symbol' | 'prose';

// Brief out-of-bounds entries arrive in three shapes: paths ("src/slug.ts"),
// bannable symbols ("SECRET_TOKEN"), and reviewer prose ("Modifying
// `src/slug.ts`, or any config files."). Prose is guidance for the reviewer —
// substring-matching it against paths or diff text only produces false errors.
function classifyOutOfBoundsPattern(pattern: string): OutOfBoundsPatternKind {
  const token = pattern.trim();
  if (token === '' || /\s/.test(token)) return 'prose';
  if (token.includes('/') || token.includes('*') || /\.[A-Za-z0-9]+$/.test(token)) return 'path';
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token)) return 'symbol';
  return 'prose';
}

function matchesOutOfBoundsPath(file: string, pattern: string): boolean {
  const token = pattern.trim().replace(/\/+$/, '');
  if (matchesActionPattern(file, token)) return true;
  return !token.includes('*') && file.startsWith(`${token}/`);
}

export function analyzeBriefDrift(input: AnalyzeBriefDriftInput): DriftReport {
  const findings: DriftFinding[] = [];
  const expectedFiles = uniqueInOrder(input.tasks.map((task) => task.file).filter(Boolean)).sort();
  const acceptedPatterns = input.tasks.flatMap(taskAcceptedPatterns);
  const isSessionArtifact = (file: string): boolean =>
    SESSION_ARTIFACT_FILES.has(file) &&
    !acceptedPatterns.some((pattern) => matchesActionPattern(file, pattern));
  const changedFiles = uniqueInOrder(input.changedFiles)
    .filter((file) => !isSessionArtifact(file))
    .sort();

  // Files attributed to task execution by the evidence ledger.
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

  const outOfBoundsPatterns: string[] = [];
  for (const task of input.tasks) {
    for (const p of task.scope?.outOfBounds ?? []) {
      if (p) outOfBoundsPatterns.push(p);
    }
  }
  const hasExplicitOutOfBounds = outOfBoundsPatterns.length > 0;

  // A file some Task Brief declares as its target is a brief-ordered change,
  // never an out-of-bounds hit, even when another task's scope forbids it.
  const isTaskTarget = (file: string): boolean =>
    input.tasks.some((task) => task.file && matchesActionPattern(file, task.file));
  const contentDiff = stripSessionArtifactDiffSections(input.diff);

  for (const pattern of outOfBoundsPatterns) {
    const kind = classifyOutOfBoundsPattern(pattern);
    if (kind === 'prose') continue;
    // A bare word is both a legal identifier and a legal directory name
    // ("node_modules", "vendor"), so the changed-file list is consulted for
    // every non-prose pattern: an attributed file names the offender, while
    // the diff-text scan can only report that some line matched.
    const fileHit = changedFiles.find(
      (f) => !isTaskTarget(f) && matchesOutOfBoundsPath(f, pattern),
    );
    if (fileHit) {
      findings.push({
        severity: 'error',
        code: 'out_of_bounds_text_match',
        file: fileHit,
        message: `Out-of-bounds pattern "${pattern}" matched changed file ${fileHit}.`,
      });
      continue;
    }
    if (kind === 'path') continue;
    if (contentDiff.includes(pattern.trim())) {
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
      if (!entry.observedEvidence.some(isInformativeEvidence)) {
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
