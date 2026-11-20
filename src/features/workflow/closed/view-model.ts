import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { SetAside } from '../../../core/schemas/review/verdict.js';
import type {
  BriefQualitySummary,
  FinalReviewVerdict,
  Summary,
} from '../../../core/schemas/summary.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { RunCheckpoint, RunRecord } from '../../../core/sessions/run/record.js';
import { awaitsApply, canUndoApply, type RunStatus } from '../../../core/sessions/run/status.js';
import {
  oneLineDisplayText,
  sanitizeTerminalDisplayText,
} from '../../../utils/display-text/sanitize.js';
import type { RailStageState } from '../../../core/phases/rail.js';
import { acceptedCounts, acceptedNote } from '../../../core/review/accepted.js';
import { atRestRailStages } from '../at-rest.js';
import { filesView, phaseTimings, runDigest, scopeView } from './projections.js';
import { failedReviewViews, reviewView } from './review-views.js';
import { briefRows, stoppedAtForCurrentPlan } from './brief-rows.js';
import { buildSeatView, plannerSeatView, reviewSeatView } from './seat-views.js';

/** How a closed run reads: every check agreed, something needs a look, or it was ended. */
export type SummaryOutcomeKind = 'complete' | 'needs-attention' | 'ended' | 'applied' | 'discarded';

export type SeatView =
  | Readonly<{
      kind: 'named';
      short: string;
      /** The seat with its tool, the way the live crew rows name it. */
      full: string;
      /** The command the crew line falls back to when the seat's name does not fit. */
      tool: string;
    }>
  | Readonly<{ kind: 'inherits' }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'mixed'; profiles: readonly string[] }>
  | Readonly<{
      kind: 'moved';
      /** Each seat the briefs ran on, in the order the plan first used it, and how many it ran. */
      seats: readonly Readonly<{ short: string; briefs: number }>[];
      /** Each seat ran one unbroken stretch of the plan, so the order is the order it moved in. */
      contiguous: boolean;
    }>
  | Readonly<{ kind: 'unset' }>;

export type RecordedCrew = Readonly<{ plan: SeatView; build: SeatView; review: SeatView }>;

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
  | Readonly<{ kind: 'not-run' | 'none' }>
  | Readonly<{ kind: 'failed' | 'missing' | 'skipped' }>
  | Readonly<{
      kind: 'written';
      verdict: FinalReviewVerdict | null;
      counts: Readonly<{ critical: number; warning: number; note: number }>;
      markdownPath: string;
      evidence: Readonly<{ validated: number; total: number }>;
      missingArtifacts: number;
      /** The reviewer checks the review saw red at the run base too, with their first failures. */
      preExisting: readonly PreExistingCheckView[];
      /** The red inputs the review set aside, each with the reviewer's reason. */
      setAside: readonly SetAside[];
    }>;

export type PreExistingCheckView = Readonly<{ id: string; command: string; tests: string[] }>;

/** A review that failed before the review of record, and what failed it. */
export type FailedReviewView = Readonly<{
  label: string;
  blocking: readonly Readonly<{ id: string; text: string }>[];
  setAside: readonly SetAside[];
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

/** A finding of the review of record, as the summary quotes it. */
export type ReviewNoteView = Readonly<{
  id: string;
  file: string | null;
  text: string;
  blocking?: boolean;
}>;

/**
 * What the closed summary states beyond the ledger rows. A fact the record cannot give is null,
 * and the row that would state it leaves it out.
 */
export interface RunDigest {
  /** The briefs the plan compiled, without the ones a fix cycle added. */
  plannedBriefs: number | null;
  planCriteria: number | null;
  fixBriefs: number;
  fixCycles: number;
  notes: readonly ReviewNoteView[];
  criteria: Readonly<{ passed: number; total: number }> | null;
  /** The changed files the summary names: the ones the most briefs changed, test files last. */
  leadFiles: readonly string[];
  testFiles: number;
}

export interface SummaryView {
  outcome: Readonly<{ kind: SummaryOutcomeKind }>;
  run: Readonly<{
    sessionId: string;
  }>;
  rail: RailStageState[];
  seats: RecordedCrew;
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
  /**
   * The failed review the user or the planner accepted as is: the red checks it recorded, by id
   * (`1 red check: V1`), and the owner's note.
   */
  accepted: Readonly<{ redChecks: string | null; note: string | null }> | null;
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
  /** When the run closed, in ms; null when its state kept no time that reads as one. */
  closedAt: number | null;
  digest: RunDigest;
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
      sessionId,
    },
    rail: atRestRailStages(record),
    seats: seatsOf(summary),
    briefs: {
      total: summary.totalTasks,
      passed: summary.completedByLocal,
      failed: summary.failed,
      rows: rows.current,
      earlierRows: rows.earlier,
    },
    review: reviewView(summary, state?.review?.preExistingChecks ?? [], ledger),
    failedReviews: failedReviewViews(ledger),
    accepted: acceptedView(state?.acceptedAsIs),
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
    closedAt: closedAtOf(state),
    digest: runDigest({ summary, ledger, state, changed: files.changed }),
  };
}

/** The close of the run, or its completion on a run that ended with no close on record. */
function closedAtOf(state: WorkflowState | null): number | null {
  const at = Date.parse(state?.closed?.at ?? state?.completedAt ?? '');
  return Number.isNaN(at) ? null : at;
}

/**
 * The crew a run names from its record. A closed run and a run whose reviewed result waits for
 * Apply will not build again, so they name the crew that built them. Any other run names the crew
 * it will build on when it continues, which is today's: null.
 */
export function recordedCrew(record: RunRecord): RecordedCrew | null {
  if (record.summary === null) return null;
  const built =
    record.status.kind === 'closed' ||
    (record.hydration.kind === 'loaded' && awaitsApply(record.hydration.state));
  return built ? seatsOf(record.summary) : null;
}

function seatsOf(summary: Summary): RecordedCrew {
  return {
    plan: plannerSeatView(summary),
    build: buildSeatView(summary),
    review: reviewSeatView(summary),
  };
}

/**
 * Complete is the whole run agreeing: it finished, the packet was written, the verdict allows it, the
 * scope check passed and no brief failed. Anything short of that on a finished run needs attention.
 * With REVIEW None no packet or scope check is written, so the briefs and a recorded scope answer.
 */
function outcomeKindFor(
  summary: Summary,
  closedAs: Extract<RunStatus, { kind: 'closed' }>['as'],
): SummaryOutcomeKind {
  if (closedAs === 'ended') return 'ended';
  // An undone Apply reads as the Apply it took back; the view's `applyUndo` names the undo.
  if (closedAs === 'applied' || closedAs === 'undone') return 'applied';
  if (closedAs === 'discarded') return 'discarded';
  if (summary.reviewerSeat === 'none') {
    return summary.failed === 0 && summary.driftSummary?.passed !== false
      ? 'complete'
      : 'needs-attention';
  }
  const packet = summary.reviewPacket;
  const verdict = packet?.finalReviewVerdict ?? null;
  const agreed =
    packet?.finalReviewStatus === 'written' &&
    (verdict === 'pass' || verdict === 'pass_with_notes') &&
    packet.driftPassed === true &&
    summary.failed === 0;
  return agreed ? 'complete' : 'needs-attention';
}

/** The accept as is the run's state holds, as its row spells it: the red checks by id, the note. */
function acceptedView(accepted: WorkflowState['acceptedAsIs']): SummaryView['accepted'] {
  if (accepted === undefined) return null;
  const redChecks = acceptedCounts(accepted).redCheckIds;
  return {
    redChecks: redChecks === undefined ? null : oneLineDisplayText(redChecks),
    note: acceptedNote(accepted) ?? null,
  };
}

/** The run.patch the close recorded; a run that changed no file left nothing in it. */
function savedPatch(state: WorkflowState | null, changed: readonly string[] | null): string | null {
  const patch = state?.closed?.patch;
  if (patch === undefined || changed?.length === 0) return null;
  return sanitizeTerminalDisplayText(patch);
}
