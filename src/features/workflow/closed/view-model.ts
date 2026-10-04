import type { Phase, TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { BriefQualitySummary, ReviewVerdict, Summary } from '../../../core/schemas/summary.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { RunRecord } from '../../../core/sessions/run-record.js';
import type { RunStatus } from '../../../core/sessions/run-status.js';
import type { RailStageStatus } from '../../../core/rail-stages.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { getRailStages, type RailHalt, type RailStageState } from '../../../core/rail-stages.js';
import { applyStage } from '../at-rest.js';
import {
  briefRows,
  buildSeatView,
  costView,
  filesView,
  phaseTimings,
  plannerSeatView,
  reviewSeatView,
  reviewView,
  scopeView,
  stoppedAtForCurrentPlan,
  tokensView,
} from './projections.js';

/** How a closed run reads: every check agreed, something needs a look, or it was ended. */
export type SummaryOutcomeKind = 'ready' | 'needs-attention' | 'ended' | 'applied' | 'discarded';

export type SeatView =
  | Readonly<{ kind: 'named'; identity: string; short: string }>
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
      driftPassed: boolean | null;
      evidence: Readonly<{ validated: number; total: number }>;
      missingArtifacts: number;
    }>;

export type ScopeView =
  | Readonly<{ kind: 'not-run' }>
  | Readonly<{
      kind: 'checked';
      passed: boolean;
      score: number;
      errors: number;
      warnings: number;
    }>;

export type CostView =
  | Readonly<{ kind: 'unmetered'; label: string }>
  | Readonly<{ kind: 'unpriced' }>
  | Readonly<{ kind: 'priced'; actual: number; partial: boolean }>;

export type PhaseTiming = Readonly<{ phase: 'planning' | 'implementing' | 'review'; ms: number }>;

export interface SummaryView {
  outcome: Readonly<{ kind: SummaryOutcomeKind }>;
  run: Readonly<{
    feature: string;
    totalMs: number;
    phase: Phase;
    sessionId: string;
  }>;
  rail: RailStageState[];
  seats: Readonly<{ plan: SeatView; build: SeatView; review: SeatView }>;
  briefs: Readonly<{
    total: number;
    passed: number;
    local: number;
    escalated: number;
    failed: number;
    skipped: number;
    rows: BriefRow[];
    earlierRows: BriefRow[];
  }>;
  review: ReviewView;
  scope: ScopeView;
  quality: BriefQualitySummary | null;
  /** Null when the reader turned the spend display off: the run has no cost row at all. */
  cost: CostView | null;
  tokens: Readonly<{ plan: number; build: number; review: number }>;
  files: Readonly<{
    changed: string[] | null;
    partial: ReadonlySet<string>;
    stoppedAt: Readonly<{ taskId: TaskId; partialFiles: string[] }> | null;
    /** An ended or discarded workspace run saved its changes in run.patch. */
    patch: boolean;
  }>;
  checkpoint: 'accepted' | 'rejected' | null;
  phases: PhaseTiming[];
}

/**
 * The run record, plus the one display preference the screen reads from config: the closed block
 * derives its view from the record navigation carried and nothing else.
 */
export interface DeriveSummaryViewInput {
  record: RunRecord;
  /** `workflow.showSpend`; absent reads as on, the way the config default does. */
  showSpend?: boolean | undefined;
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
  const phase = resolvePhase(summary, savedPhase(record));
  const tasks = state?.tasks ?? null;
  const rows = briefRows({ summary, ledger, currentTasks: tasks });
  const apply = applyStage(record);
  return {
    outcome: { kind: outcomeKind },
    run: {
      feature: sanitizeTerminalDisplayText(summary.feature),
      totalMs: summary.totalTime,
      phase,
      sessionId: sanitizeTerminalDisplayText(record.ref.sessionId),
    },
    rail: railFor(phase, outcomeKind, apply),
    seats: {
      plan: plannerSeatView(summary),
      build: buildSeatView(summary),
      review: reviewSeatView(summary),
    },
    briefs: {
      total: summary.totalTasks,
      passed: summary.completedByLocal,
      local: summary.completedByLocal,
      escalated: summary.escalatedToPlanner,
      failed: summary.failed,
      skipped: summary.skipped,
      rows: rows.current,
      earlierRows: rows.earlier,
    },
    review: reviewView(summary),
    scope: scopeView(summary),
    quality: summary.briefQuality ?? null,
    cost: input.showSpend === false ? null : costView(summary.costBreakdown),
    tokens: tokensView(summary),
    files: { ...filesView(summary), patch: workspacePatch(record, state) },
    checkpoint: record.checkpoint?.kind ?? null,
    phases: phaseTimings(summary),
  };
}

function savedPhase(record: RunRecord): Phase | null {
  return record.hydration.kind === 'loaded' ? record.hydration.state.phase : null;
}

/**
 * Ready is the whole run agreeing: it finished, the packet was written, the verdict allows it, the
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
  const ready =
    packet?.finalReviewStatus === 'written' &&
    (verdict === 'pass' || verdict === 'pass_with_notes') &&
    packet.driftPassed === true &&
    summary.failed === 0;
  return ready ? 'ready' : 'needs-attention';
}

/** An ended or discarded workspace run left its changes in run.patch; nothing else is a patch. */
function workspacePatch(record: RunRecord, state: WorkflowState | null): boolean {
  const workspace = state?.workspace;
  if (workspace === undefined || workspace.kind === 'checkout') return false;
  const status = record.status;
  return status.kind === 'closed' && (status.as === 'ended' || status.as === 'discarded');
}

/**
 * The phase the run stopped in. The saved state is read first, then the summary's own record, then
 * what the record does carry — so a legacy summary still freezes the rail at the right stage.
 */
function resolvePhase(summary: Summary, saved: Phase | null): Phase {
  // `idle` is where a run that never started stands, so it names no stage.
  const recorded = saved ?? summary.phase ?? null;
  if (recorded !== null && recorded !== 'idle') return recorded;
  if (summary.stoppedAt !== undefined || summary.totalTasks > 0) return 'implementing';
  if (summary.reviewPacket !== undefined) return 'final-review';
  return 'planning';
}

function railFor(
  phase: Phase,
  kind: SummaryOutcomeKind,
  apply: RailStageStatus | undefined,
): RailStageState[] {
  const applyOption = apply === undefined ? {} : { apply };
  if (kind !== 'ended') return getRailStages('complete', applyOption);
  return getRailStages(phase, { halted: ENDED_HALT, ...applyOption });
}

/** A run somebody ended is not a run that broke: the stage it stopped on wears the cancel mark. */
const ENDED_HALT: RailHalt = 'cancelled';
