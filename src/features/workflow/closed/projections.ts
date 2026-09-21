import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { EvidenceLedger, EvidenceTask } from '../../../core/schemas/evidence.js';
import type { CostBreakdown, Summary } from '../../../core/schemas/summary.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type {
  BriefRow,
  BriefRowState,
  CostView,
  PhaseTiming,
  ReviewView,
  ScopeView,
  SeatView,
  SummaryView,
} from './view-model.js';
import { costKnownFlags, unmeteredRunCostLabel } from '../../../core/schemas/summary.js';
import { formatToolModel } from '../../../core/model-display.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { classifyTaskCompletionMethod } from '../../../core/task-completion.js';
import { uniqueSorted } from '../../../utils/collections.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';

export function seatView(tool: string | undefined, model: string | undefined): SeatView {
  if (tool === undefined) return { kind: 'unset' };
  return {
    kind: 'named',
    identity: sanitizeTerminalDisplayText(formatToolModel(tool, model)),
    short: sanitizeTerminalDisplayText(model ?? getProviderDisplayName(tool)),
  };
}

/** A run whose briefs went to more than one seat names the profiles, never one global implementer. */
export function buildSeatView(summary: Summary): SeatView {
  const breakdown = summary.taskBreakdown ?? [];
  const identified = breakdown.filter(
    (task) =>
      task.tool !== undefined || task.model !== undefined || task.implementerProfile !== undefined,
  );
  const keys = new Set(
    identified.map(
      (task) => `${task.implementerProfile ?? ''}\u0000${task.tool ?? ''}\u0000${task.model ?? ''}`,
    ),
  );
  if (keys.size > 1) {
    return {
      kind: 'mixed',
      profiles: uniqueSorted(
        breakdown
          .map((task) => task.implementerProfile)
          .filter((profile): profile is string => profile !== undefined),
      ).map((profile) => sanitizeTerminalDisplayText(profile)),
    };
  }
  return seatView(summary.implementerTool, summary.implementerModel);
}

export function reviewSeatView(summary: Summary): SeatView {
  if (summary.reviewerTool !== undefined) {
    return seatView(summary.reviewerTool, summary.reviewerModel);
  }
  return summary.plannerTool === undefined ? { kind: 'unset' } : { kind: 'inherits' };
}

/**
 * Plan order comes from the ledger, which is seeded with every brief the planner compiled; the
 * per-brief spend record joins onto it by id. A brief the ledger never saw still appears, because
 * the spend record is the only place a run that died before its first write left a trace.
 */
export function briefRows(summary: Summary, ledger: EvidenceLedger | null): BriefRow[] {
  const spend = new Map<string, TaskTokenUsage>();
  for (const task of summary.taskBreakdown ?? []) spend.set(task.taskId, task);
  const stoppedId = summary.stoppedAt?.taskId;
  const partialFiles = summary.stoppedAt?.partialFiles.length ?? 0;
  const ledgerTasks = ledger?.tasks ?? [];
  const seen = new Set<string>();
  const rows: BriefRow[] = [];

  for (const task of ledgerTasks) {
    seen.add(task.id);
    rows.push(
      briefRow({
        id: task.id,
        title: task.title,
        booked: spend.get(task.id),
        ledgerTask: task,
        stopped: task.id === stoppedId,
        partialFiles,
      }),
    );
  }
  for (const task of summary.taskBreakdown ?? []) {
    if (seen.has(task.taskId)) continue;
    seen.add(task.taskId);
    rows.push(
      briefRow({
        id: task.taskId,
        title: task.taskTitle,
        booked: task,
        ledgerTask: undefined,
        stopped: task.taskId === stoppedId,
        partialFiles,
      }),
    );
  }
  return rows;
}

function briefRow(input: {
  id: TaskId;
  title: string;
  booked: TaskTokenUsage | undefined;
  ledgerTask: EvidenceTask | undefined;
  stopped: boolean;
  partialFiles: number;
}): BriefRow {
  const { booked, ledgerTask } = input;
  const method = booked?.method ?? ledgerTask?.method ?? null;
  return {
    id: input.id,
    title: sanitizeTerminalDisplayText(input.title),
    state: briefRowState({ method, ledgerTask, stopped: input.stopped }),
    method,
    retries: booked?.retryCount ?? ledgerTask?.retries ?? 0,
    durationMs: ledgerTask?.durationMs ?? null,
    file: ledgerTask?.file === undefined ? null : sanitizeTerminalDisplayText(ledgerTask.file),
    partialFiles: input.stopped ? input.partialFiles : 0,
  };
}

function briefRowState(input: {
  method: TaskCompletionMethod | null;
  ledgerTask: EvidenceTask | undefined;
  stopped: boolean;
}): BriefRowState {
  if (input.stopped) return 'stopped';
  if (input.method !== null) return classifyTaskCompletionMethod(input.method);
  const status = input.ledgerTask?.status;
  if (status === 'done') return input.ledgerTask?.escalated === true ? 'escalated' : 'local';
  if (status === 'failed') return 'failed';
  if (status === 'escalated') return 'escalated';
  if (status === 'skipped') return 'skipped';
  return 'pending';
}

/** The packet is the review of record; `summary.review` only answers for sessions written before it. */
export function reviewView(summary: Summary): ReviewView {
  const packet = summary.reviewPacket;
  if (packet === undefined) {
    const legacy = summary.review;
    if (legacy === undefined) return { kind: 'not-run' };
    return {
      kind: 'written',
      verdict: legacy.verdict,
      counts: { critical: legacy.critical, warning: legacy.warnings, note: legacy.notes },
      markdownPath: '',
      driftPassed: summary.driftSummary?.passed ?? null,
      evidence: {
        validated: summary.evidenceSummary?.tasksWithValidationEvidence ?? 0,
        total: summary.evidenceSummary?.totalTasks ?? summary.totalTasks,
      },
      missingArtifacts: 0,
    };
  }
  if (packet.finalReviewStatus !== 'written') return { kind: packet.finalReviewStatus };
  return {
    kind: 'written',
    verdict: packet.finalReviewVerdict,
    counts: packet.finalReviewFindingCounts,
    markdownPath: sanitizeTerminalDisplayText(packet.markdownPath),
    driftPassed: packet.driftPassed,
    evidence: { validated: packet.evidenceValidatedTasks, total: packet.evidenceTotalTasks },
    missingArtifacts: packet.missingArtifactCount,
  };
}

export function scopeView(summary: Summary): ScopeView {
  const drift = summary.driftSummary;
  if (drift === undefined) return { kind: 'not-run' };
  return {
    kind: 'checked',
    passed: drift.passed,
    score: drift.score,
    errors: drift.errorCount,
    warnings: drift.warningCount,
  };
}

/**
 * A run billed entirely outside per-token metering has no dollar figure to report, and printing
 * `$0.00` for it states a charge that never happened.
 */
export function costView(breakdown: CostBreakdown | undefined): CostView {
  if (breakdown === undefined) return { kind: 'unpriced' };
  const unmetered = unmeteredRunCostLabel(breakdown);
  if (unmetered !== null) return { kind: 'unmetered', label: unmetered };
  if (breakdown.hasPricedUsage !== true) return { kind: 'unpriced' };
  const flags = costKnownFlags(breakdown);
  return {
    kind: 'priced',
    actual: breakdown.totalActualCost,
    partial: !flags.totalCostKnown,
  };
}

export function tokensView(summary: Summary): SummaryView['tokens'] {
  const usage = summary.tokenUsage;
  return {
    plan: usage.plannerInput + usage.plannerOutput,
    build:
      usage.implementerInput +
      usage.implementerOutput +
      usage.escalationInput +
      usage.escalationOutput,
    review: usage.reviewerInput + usage.reviewerOutput,
  };
}

export function filesView(summary: Summary): SummaryView['files'] {
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
    stoppedAt: stoppedAt === undefined ? null : { taskId: stoppedAt.taskId, partialFiles },
  };
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
