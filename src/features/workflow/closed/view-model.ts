import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { BriefQualitySummary, ReviewVerdict, Summary } from '../../../core/schemas/summary.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { RunCheckpoint, RunRecord } from '../../../core/sessions/run-record.js';
import { canUndoApply, type RunStatus } from '../../../core/sessions/run-status.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import type { RailStageState } from '../../../core/rail-stages.js';
import { atRestRailStages } from '../at-rest.js';
import {
  briefRows,
  buildSeatView,
  failedReviewViews,
  filesView,
  phaseTimings,
  plannerSeatView,
  reviewSeatView,
  reviewView,
  scopeView,
  stoppedAtForCurrentPlan,
} from './projections.js';

/** How a closed run reads: every check agreed, something needs a look, or it was ended. */
export type SummaryOutcomeKind = 'complete' | 'needs-attention' | 'ended' | 'applied' | 'discarded';

export type SeatView =
  | Readonly<{ kind: 'named'; short: string }>
  | Readonly<{ kind: 'inherits' }>
  | Readonly<{ kind: 'mixed'; profiles: readonly string[] }>
  | Readonly<{
      kind: 'moved';
      /** Each seat the briefs ran on, in the order the plan first used it, and how many it ran. */
      seats: readonly Readonly<{ short: string; briefs: number }>[];
      /** Each seat ran one unbroken stretch of the plan, so the order is the order it moved in. */
      contiguous: boolean;
    }>
  | Readonly<{ kind: 'unset' }>;

export type BriefRowState = 'local' | 'escalated' | 'failed' | 'skipped' | 'stopped' | 'pending';

export interface BriefRow {
  id: TaskId;
  title: string;
  state: BriefRowState;
  method: TaskCompletionMethod | null;
  retries: number;
  durationMs: number | null;
  file: string | null;
  fileNote?: string | undefined;
  extraFiles?: string | undefined;
  partialFiles: number;
}

export type ReviewView =
  | Readonly<{ kind: 'not-run' }>
  | Readonly<{ kind: 'failed' | 'missing' | 'skipped' }>
  | Readonly<{
      kind: 'written';
      verdict: ReviewVerdict | null;
      counts: Readonly<{ critical: number; warning: number; note: number }>;
      markdownPath: string;
      evidence: Readonly<{ validated: number; total: number }>;
      missingArtifacts: number;
      /** The reviewer checks the review saw red at the run base too, with their first failures. */
      preExisting: readonly PreExistingCheckView[];
    }>;

export type PreExistingCheckView = Readonly<{ id: string; command: string; tests: string[] }>;

/** A review that failed before the review of record, and what failed it. */
export type FailedReviewView = Readonly<{
  label: string;
  blocking: readonly Readonly<{ id: string; text: string }>[];
}>;

export type ScopeView =
  | Readonly<{ kind: 'not-run' }>
  | Readonly<{
      kind: 'checked';
      passed: boolean;
      errors: number;
      warnings: number;
    }>;

export type PhaseTiming = Readonly<{ phase: 'planning' | 'implementing' | 'review'; ms: number }>;

export interface SummaryView {
  outcome: Readonly<{ kind: SummaryOutcomeKind }>;
  run: Readonly<{
    feature: string;
    sessionId: string;
  }>;
  rail: RailStageState[];
  seats: Readonly<{ plan: SeatView; build: SeatView; review: SeatView }>;
  briefs: Readonly<{
    total: number;
    passed: number;
    failed: number;
    rows: BriefRow[];
    earlierRows: BriefRow[];
  }>;
  review: ReviewView;
  /** The reviews that failed before the review of record, so a fix cycle leaves its trace. */
  failedReviews: readonly FailedReviewView[];
  scope: ScopeView;
  quality: BriefQualitySummary | null;
  files: Readonly<{
    changed: string[] | null;
    partial: ReadonlySet<string>;
    stoppedAt: Readonly<{ taskId: TaskId }> | null;
    /** The run.patch an ended or discarded workspace run saved its changes in, project-relative. */
    patch: string | null;
  }>;
  checkpoint: RunCheckpoint | null;
  canUndoApply: boolean;
  applyUndo: Readonly<{ conflicts: readonly string[] }> | null;
  phases: PhaseTiming[];
  /** How long the run ran, in ms; null on a record from before it was kept. */
  ran: number | null;
}

/** The closed block derives its view from the record navigation carried and nothing else. */
export interface DeriveSummaryViewInput {
  record: RunRecord;
}

/**
 * What a closed run is, in one view. Null for a run that is still open — an open run has no
 * outcome yet — and for a closed run that left no record to read.
 */
export function deriveSummaryView(input: DeriveSummaryViewInput): SummaryView | null {
  const { record } = input;
  if (record.status.kind !== 'closed') return null;
  if (record.summary === null) return null;
  const ledger = record.ledger;
  const state = record.hydration.kind === 'loaded' ? record.hydration.state : null;
  const summary = {
    ...record.summary,
    stoppedAt: stoppedAtForCurrentPlan({ summary: record.summary, ledger, state }),
  };
  const outcomeKind = outcomeKindFor(summary, record.status.as);
  const tasks = state?.tasks ?? null;
  const rows = briefRows({ summary, ledger, currentTasks: tasks });
  const files = filesView(summary);
  const sessionId = sanitizeTerminalDisplayText(record.ref.sessionId);
  return {
    outcome: { kind: outcomeKind },
    run: {
      feature: sanitizeTerminalDisplayText(summary.feature),
      sessionId,
    },
    rail: atRestRailStages(record),
    seats: {
      plan: plannerSeatView(summary),
      build: buildSeatView(summary),
      review: reviewSeatView(summary),
    },
    briefs: {
      total: summary.totalTasks,
      passed: summary.completedByLocal,
      failed: summary.failed,
      rows: rows.current,
      earlierRows: rows.earlier,
    },
    review: reviewView(summary, state?.review?.preExistingChecks ?? []),
    failedReviews: failedReviewViews(ledger),
    scope: scopeView(summary),
    quality: summary.briefQuality ?? null,
    files: { ...files, patch: savedPatch(state, files.changed) },
    checkpoint: record.checkpoint,
    canUndoApply: state !== null && canUndoApply(state),
    applyUndo:
      state?.applied?.undone === undefined
        ? null
        : {
            conflicts: state.applied.undone.conflicts.map((path) =>
              sanitizeTerminalDisplayText(path),
            ),
          },
    phases: phaseTimings(summary),
    ran: summary.activeTime ?? null,
  };
}

/**
 * Complete is the whole run agreeing: it finished, the packet was written, the verdict allows it, the
 * scope check passed and no brief failed. Anything short of that on a finished run needs attention.
 */
function outcomeKindFor(
  summary: Summary,
  closedAs: Extract<RunStatus, { kind: 'closed' }>['as'],
): SummaryOutcomeKind {
  if (closedAs === 'ended') return 'ended';
  if (closedAs === 'applied') return 'applied';
  if (closedAs === 'discarded') return 'discarded';
  const packet = summary.reviewPacket;
  const verdict = packet?.finalReviewVerdict ?? null;
  const agreed =
    packet?.finalReviewStatus === 'written' &&
    (verdict === 'pass' || verdict === 'pass_with_notes') &&
    packet.driftPassed === true &&
    summary.failed === 0;
  return agreed ? 'complete' : 'needs-attention';
}

/** The run.patch the close recorded; a run that changed no file left nothing in it. */
function savedPatch(state: WorkflowState | null, changed: readonly string[] | null): string | null {
  const patch = state?.closed?.patch;
  if (patch === undefined || changed?.length === 0) return null;
  return sanitizeTerminalDisplayText(patch);
}
