import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { fixCyclesOf } from '../../../core/state/selectors.js';
import { isTestScript } from '../../../core/validation/stacks/registry.js';
import { reviewOutcomeOf } from '../../../core/review/verdict.js';
import type { PhaseTiming, RunDigest, ScopeView, SummaryView } from './view-model.js';
import { uniqueSorted } from '../../../utils/collections.js';
import {
  oneLineDisplayText,
  sanitizeTerminalDisplayText,
} from '../../../utils/display-text/sanitize.js';

export function scopeView(summary: Summary): ScopeView {
  const drift = summary.driftSummary;
  if (drift === undefined) return { kind: 'not-run' };
  return {
    kind: 'checked',
    passed: drift.passed,
    errors: drift.errorCount,
    warnings: drift.warningCount,
  };
}

export function filesView(summary: Summary): Omit<SummaryView['files'], 'patch'> {
  const stoppedAt = summary.stoppedAt;
  const partialFiles = uniqueSorted(
    (stoppedAt?.partialFiles ?? []).map((file) => sanitizeTerminalDisplayText(file)),
  );
  return {
    changed:
      summary.changedFiles === undefined
        ? null
        : uniqueSorted(summary.changedFiles.map((file) => sanitizeTerminalDisplayText(file))),
    partial: new Set(partialFiles),
    stoppedAt: stoppedAt === undefined ? null : { taskId: stoppedAt.taskId },
  };
}

/** How many changed files the summary names before it counts the rest. */
const LEAD_FILES = 3;
/** A run this small names every file: the paths say more than a count of two hidden ones. */
const ALL_FILES_LIMIT = 5;

/** Source files before test files, then the files the most briefs changed; ties keep path order. */
function leadFiles(changed: readonly string[], ledger: EvidenceLedger | null): string[] {
  const briefs = new Map<string, number>();
  for (const task of ledger?.tasks ?? []) {
    for (const file of new Set(task.changedFiles)) briefs.set(file, (briefs.get(file) ?? 0) + 1);
  }
  const ordered = changed.toSorted(
    (left, right) =>
      Number(isTestScript(left)) - Number(isTestScript(right)) ||
      (briefs.get(right) ?? 0) - (briefs.get(left) ?? 0),
  );
  return ordered.length <= ALL_FILES_LIMIT ? ordered : ordered.slice(0, LEAD_FILES);
}

export function runDigest(input: {
  summary: Summary;
  ledger: EvidenceLedger | null;
  state: WorkflowState | null;
  changed: readonly string[] | null;
}): RunDigest {
  const { summary, ledger, state } = input;
  const changed = input.changed ?? [];
  const fixBriefs = (state?.triage ?? []).reduce(
    (sum, record) => sum + record.result.fixTasks.length,
    0,
  );
  // A task review is not the review of record: its findings belong to its brief. The outcome
  // applies the checks that verified the review's claims, as the counts of the packet do.
  const review = state?.review;
  const outcome = review === undefined || review.scope === 'task' ? null : reviewOutcomeOf(review);
  const criteria = outcome?.criteria ?? [];
  return {
    plannedBriefs: state === null ? null : Math.max(0, summary.totalTasks - fixBriefs),
    planCriteria: state?.plan?.criteria.length ?? null,
    fixBriefs,
    fixCycles: state === null ? 0 : fixCyclesOf(state).used,
    notes: (outcome === null ? [] : [...outcome.minor, ...outcome.outOfScope]).map((finding) => ({
      id: oneLineDisplayText(finding.id),
      file: finding.file === null ? null : oneLineDisplayText(finding.file),
      text: oneLineDisplayText(finding.text),
    })),
    criteria:
      criteria.length === 0
        ? null
        : {
            passed: criteria.filter((criterion) => criterion.status === 'pass').length,
            total: criteria.length,
          },
    leadFiles: leadFiles(changed, ledger),
    testFiles: changed.filter((file) => isTestScript(file)).length,
  };
}

export function changedFileCount(summary: Summary | null): number | null {
  return summary === null ? null : (filesView(summary).changed?.length ?? null);
}

/** The three keys the orchestrator writes; anything else in the record is not a phase of this run. */
const PHASE_TIMING_KEYS = [
  'planning',
  'implementing',
  'review',
] as const satisfies readonly PhaseTiming['phase'][];

export function phaseTimings(summary: Summary): PhaseTiming[] {
  const timings = summary.phaseTimings;
  if (timings === undefined) return [];
  const rows: PhaseTiming[] = [];
  for (const phase of PHASE_TIMING_KEYS) {
    const ms = timings[phase];
    if (ms !== undefined && ms > 0) rows.push({ phase, ms });
  }
  return rows;
}
