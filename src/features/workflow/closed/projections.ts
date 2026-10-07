import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { EvidenceLedger, EvidenceTask } from '../../../core/schemas/evidence.js';
import type { CostBreakdown, Summary } from '../../../core/schemas/summary.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
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
import { formatSeatIdentity, formatShortSeatIdentity } from '../../../core/crew/identity.js';
import {
  getProviderDisplayName,
  getRunnerIdentityDisplayName,
  parseRunnerIdentityKey,
} from '../../../core/providers/catalog.js';
import type { RunnerKind } from '../../../core/schemas/enums.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import { resolveModelDisplayName } from '../../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { classifyTaskCompletionMethod } from '../../../core/task-completion.js';
import { uniqueSorted } from '../../../utils/collections.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { hashTaskBrief } from '../../../engine/brief-hash.js';

/** A seat the run recorded, spelled by the same formatters the live crew surfaces use. */
function seatView(input: {
  tool: string | undefined;
  model: string | undefined;
  role: ActiveRunnerRole;
  kind: RunnerKind | undefined;
}): SeatView {
  const { tool, model, role, kind } = input;
  if (tool === undefined) return { kind: 'unset' };
  const seat = { tool, ...(model !== undefined && { model }) };
  const displayName =
    model === undefined
      ? undefined
      : resolveModelDisplayName({ providerId: tool, model, role, cache: modelCacheStore, kind });
  return {
    kind: 'named',
    identity: formatSeatIdentity({ seat, displayName, kind }),
    short: formatShortSeatIdentity({ seat, displayName, kind }),
  };
}

/**
 * The kind the run's own cost record kept for a recorded tool name, when it
 * kept exactly one: a run that used both `api:opencode` and `cli:opencode`
 * leaves the name ambiguous, and the record is read as written.
 */
function recordedSeatKind(summary: Summary, tool: string): RunnerKind | undefined {
  const kinds = new Set<RunnerKind>();
  for (const key of Object.keys(summary.costBreakdown?.providerRunMetadata ?? {})) {
    const parsed = parseRunnerIdentityKey(key);
    if (parsed.kind !== undefined && parsed.id === tool) kinds.add(parsed.kind);
  }
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

/** The planner seat of record, with whatever kind the run's cost record kept for it. */
export function plannerSeatView(summary: Summary): SeatView {
  const tool = summary.plannerTool;
  return seatView({
    tool,
    model: summary.plannerModel,
    role: 'planner',
    kind: tool === undefined ? undefined : recordedSeatKind(summary, tool),
  });
}

/**
 * The build seat of record, unless the briefs ran elsewhere too: briefs routed to more than one
 * profile name the profiles, and one seat that changed tools mid-run says where it went.
 */
export function buildSeatView(summary: Summary): SeatView {
  const breakdown = summary.taskBreakdown ?? [];
  const profiles = uniqueSorted(
    breakdown
      .map((task) => task.implementerProfile)
      .filter((profile): profile is string => profile !== undefined),
  );
  if (profiles.length > 1) {
    return {
      kind: 'mixed',
      profiles: profiles.map((profile) => sanitizeTerminalDisplayText(profile)),
    };
  }
  const kindOfTool = (tool: string): RunnerKind | undefined => recordedSeatKind(summary, tool);
  const implementerTool = summary.implementerTool;
  return (
    movedBuildSeat(breakdown, kindOfTool) ??
    seatView({
      tool: implementerTool,
      model: summary.implementerModel,
      role: 'implementer',
      kind: implementerTool === undefined ? undefined : recordedSeatKind(summary, implementerTool),
    })
  );
}

/**
 * The seats the briefs ran on, in the order the plan first used each, when there was more than
 * one. Two seats a short form cannot tell apart (`auto` on two tools) are named with their tool.
 */
function movedBuildSeat(
  breakdown: readonly TaskTokenUsage[],
  kindOfTool: (tool: string) => RunnerKind | undefined,
): SeatView | null {
  const seats = new Map<
    string,
    { tool: string; kind: RunnerKind | undefined; short: string; briefs: number }
  >();
  const keys: string[] = [];
  for (const task of breakdown) {
    if (task.tool === undefined) continue;
    const kind = kindOfTool(task.tool);
    const named = seatView({ tool: task.tool, model: task.model, role: 'implementer', kind });
    if (named.kind !== 'named') continue;
    const key = `${task.tool}\u0000${named.short}`;
    const seat = seats.get(key) ?? { tool: task.tool, kind, short: named.short, briefs: 0 };
    seats.set(key, { ...seat, briefs: seat.briefs + 1 });
    keys.push(key);
  }
  if (seats.size < 2) return null;
  const shorts = [...seats.values()].map((seat) => seat.short);
  const ambiguous = new Set(shorts).size < shorts.length;
  return {
    kind: 'moved',
    seats: [...seats.values()].map((seat) => ({
      short: ambiguous
        ? sanitizeTerminalDisplayText(`${runnerWord(seat.tool, seat.kind)} ${seat.short}`)
        : seat.short,
      briefs: seat.briefs,
    })),
    contiguous: eachRunsOneStretch(keys),
  };
}

/** A recorded tool name in its own kind's words; without a kind the merged catalog answers. */
function runnerWord(tool: string, kind: RunnerKind | undefined): string {
  return kind === undefined
    ? getProviderDisplayName(tool)
    : getRunnerIdentityDisplayName(kind, tool);
}

/** Whether every seat ran one unbroken stretch of the plan, so the plan order is the move order. */
function eachRunsOneStretch(keys: readonly string[]): boolean {
  const left = new Set<string>();
  let current: string | undefined;
  for (const key of keys) {
    if (key === current) continue;
    if (left.has(key)) return false;
    if (current !== undefined) left.add(current);
    current = key;
  }
  return true;
}

export function reviewSeatView(summary: Summary): SeatView {
  if (summary.reviewerTool !== undefined) {
    return seatView({
      tool: summary.reviewerTool,
      model: summary.reviewerModel,
      role: 'reviewer',
      kind: recordedSeatKind(summary, summary.reviewerTool),
    });
  }
  return summary.plannerTool === undefined ? { kind: 'unset' } : { kind: 'inherits' };
}

/** Saved tasks name the current plan. Ledger and spend rows may belong to a plan before a rewind. */
export function briefRows(input: {
  summary: Summary;
  ledger: EvidenceLedger | null;
  currentTasks: Task[] | null;
}): { current: BriefRow[]; earlier: BriefRow[] } {
  const { summary, ledger, currentTasks } = input;
  const spend = foldBriefSpend(summary.taskBreakdown ?? []);
  const stoppedId = summary.stoppedAt?.taskId;
  const partialFiles = summary.stoppedAt?.partialFiles.length ?? 0;
  const ledgerTasks = ledger?.tasks ?? [];
  const usedLedger = new Set<EvidenceTask>();
  const usedSpend = new Set<BookedBrief>();
  const current: BriefRow[] = [];

  if (currentTasks !== null) {
    const currentHash = hashTaskBrief(currentTasks);
    for (const task of currentTasks) {
      const ledgerTask = ledgerTasks.find(
        (entry) => entry.id === task.id && sameCurrentBrief(entry, task, currentHash),
      );
      if (ledgerTask !== undefined) usedLedger.add(ledgerTask);
      const booked = spend.find(
        (entry) =>
          entry.taskId === task.id &&
          entry.taskTitle === task.title &&
          task.status !== 'pending' &&
          (ledgerTask !== undefined || ledger === null),
      );
      if (booked !== undefined) usedSpend.add(booked);
      current.push(
        briefRow({
          id: task.id,
          title: task.title,
          booked,
          ledgerTask,
          stopped: task.id === stoppedId,
          partialFiles,
          currentStatus: task.status,
        }),
      );
    }
  }

  const earlier: BriefRow[] = [];
  for (const task of ledgerTasks) {
    if (usedLedger.has(task)) continue;
    const booked = spend.find(
      (entry) =>
        !usedSpend.has(entry) && entry.taskId === task.id && entry.taskTitle === task.title,
    );
    if (booked !== undefined) usedSpend.add(booked);
    earlier.push(
      briefRow({
        id: task.id,
        title: task.title,
        booked,
        ledgerTask: task,
        stopped: currentTasks === null && task.id === stoppedId,
        partialFiles: currentTasks === null ? partialFiles : 0,
      }),
    );
  }
  for (const task of spend) {
    if (usedSpend.has(task)) continue;
    earlier.push(
      briefRow({
        id: task.taskId,
        title: task.taskTitle,
        booked: task,
        ledgerTask: undefined,
        stopped: currentTasks === null && task.taskId === stoppedId,
        partialFiles: currentTasks === null ? partialFiles : 0,
      }),
    );
  }
  return currentTasks === null ? { current: earlier, earlier: [] } : { current, earlier };
}

/**
 * One brief's folded spend: the completion the last execution earned, and the retries every
 * execution spent. Repeated executions of one brief are one booking — a summary written without
 * call evidence keeps each execution as its own record — and the fold matches the priced
 * summary's own fold of the same records. A rewound brief that reused an id under another title
 * is a different brief and stays a separate fold.
 */
interface BookedBrief {
  taskId: TaskId;
  taskTitle: string;
  method: TaskCompletionMethod;
  retryCount: number;
}

function foldBriefSpend(taskBreakdown: readonly TaskTokenUsage[]): BookedBrief[] {
  const folded = new Map<string, BookedBrief>();
  for (const entry of taskBreakdown) {
    const key = `${entry.taskId}\u0000${entry.taskTitle}`;
    const previous = folded.get(key);
    folded.set(key, {
      taskId: entry.taskId,
      taskTitle: entry.taskTitle,
      method: entry.method,
      retryCount: (previous?.retryCount ?? 0) + entry.retryCount,
    });
  }
  return [...folded.values()];
}

/** A brief still in progress joins the unsettled entry: the ledger books a retried attempt failed. */
function sameCurrentBrief(ledgerTask: EvidenceTask, task: Task, planHash: string): boolean {
  if (task.status === 'pending' && ledgerTask.status !== 'pending') return false;
  const unsettled = ledgerTask.status === 'in_progress' || ledgerTask.status === 'failed';
  if (task.status === 'in_progress' && !unsettled) return false;
  if (ledgerTask.briefHash != null) return ledgerTask.briefHash === planHash;
  return ledgerTask.title === task.title && ledgerTask.file === task.suggestedFiles[0];
}

/** Older summaries can name a stopped brief whose ID a later plan reused. */
export function stoppedAtForCurrentPlan(input: {
  summary: Summary;
  ledger: EvidenceLedger | null;
  state: WorkflowState | null;
}): Summary['stoppedAt'] {
  const { summary, ledger, state } = input;
  const stopped = summary.stoppedAt;
  if (state === null || stopped === undefined) return stopped;
  const current = state.tasks[state.currentTaskIndex];
  if (
    state.phase === 'complete' ||
    current?.status !== 'in_progress' ||
    current.id !== stopped.taskId
  )
    return undefined;
  const booked = ledger?.tasks.find(
    (task) => task.id === current.id && sameCurrentBrief(task, current, hashTaskBrief(state.tasks)),
  );
  return {
    taskId: current.id,
    partialFiles: stopped.partialFiles.filter((file) => booked?.changedFiles.includes(file)),
  };
}

function briefRow(input: {
  id: TaskId;
  title: string;
  booked: BookedBrief | undefined;
  ledgerTask: EvidenceTask | undefined;
  stopped: boolean;
  partialFiles: number;
  currentStatus?: Task['status'] | undefined;
}): BriefRow {
  const { booked, ledgerTask } = input;
  const method = rowMethod(input.currentStatus, booked?.method ?? ledgerTask?.method ?? null);
  return {
    id: input.id,
    title: sanitizeTerminalDisplayText(input.title),
    state: briefRowState({
      method,
      ledgerTask,
      stopped: input.stopped,
      currentStatus: input.currentStatus,
    }),
    method,
    retries: booked?.retryCount ?? ledgerTask?.retries ?? 0,
    durationMs: ledgerTask?.durationMs ?? null,
    file: ledgerTask?.file === undefined ? null : sanitizeTerminalDisplayText(ledgerTask.file),
    partialFiles: input.stopped ? input.partialFiles : 0,
  };
}

function rowMethod(
  status: Task['status'] | undefined,
  recorded: TaskCompletionMethod | null,
): TaskCompletionMethod | null {
  if (status === undefined) return recorded;
  if (status === 'done') return 'local';
  if (status === 'escalated')
    return recorded !== null && classifyTaskCompletionMethod(recorded) === 'escalated'
      ? recorded
      : 'escalated-full';
  if (status === 'failed') return 'failed';
  if (status === 'skipped') return 'skipped';
  return null;
}

function briefRowState(input: {
  method: TaskCompletionMethod | null;
  ledgerTask: EvidenceTask | undefined;
  stopped: boolean;
  currentStatus?: Task['status'] | undefined;
}): BriefRowState {
  if (input.stopped) return 'stopped';
  if (input.currentStatus === 'pending' || input.currentStatus === 'in_progress') return 'pending';
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
