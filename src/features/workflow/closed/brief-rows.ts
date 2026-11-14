import { sameCurrentBrief } from '../../../core/evidence/same-brief.js';
import { taskTargetParts } from '../../../core/run-view/brief-labels.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { EvidenceLedger, EvidenceTask } from '../../../core/schemas/evidence.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { briefInFlight } from '../../../core/state/selectors.js';
import { classifyTaskCompletionMethod } from '../../../core/task-completion.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text/sanitize.js';
import type { BriefRow, BriefRowState } from './view-model.js';

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
    for (const task of currentTasks) {
      const ledgerTask = ledgerTasks.find(
        (entry) => entry.id === task.id && sameCurrentBrief(entry, task),
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
          currentTask: task,
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

/** Older summaries can name a stopped brief whose ID a later plan reused. */
export function stoppedAtForCurrentPlan(input: {
  summary: Summary;
  ledger: EvidenceLedger | null;
  state: WorkflowState | null;
}): Summary['stoppedAt'] {
  const { summary, ledger, state } = input;
  const stopped = summary.stoppedAt;
  if (state === null || stopped === undefined) return stopped;
  const current = briefInFlight(state);
  if (current?.id !== stopped.taskId) return undefined;
  const booked = ledger?.tasks.find(
    (task) => task.id === current.id && sameCurrentBrief(task, current),
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
  currentTask?: Task | undefined;
}): BriefRow {
  const { booked, ledgerTask, currentTask } = input;
  const currentStatus = currentTask?.status;
  const target =
    currentTask === undefined
      ? undefined
      : taskTargetParts({
          file: currentTask.suggestedFiles[0],
          files: currentTask.suggestedFiles,
          action: currentTask.action,
        });
  const file = target === undefined || target.path === '' ? ledgerTask?.file : target.path;
  const method = rowMethod(currentStatus, booked?.method ?? ledgerTask?.method ?? null);
  return {
    id: input.id,
    title: sanitizeTerminalDisplayText(input.title),
    state: briefRowState({
      method,
      ledgerTask,
      stopped: input.stopped,
      currentStatus,
    }),
    method,
    retries: booked?.retryCount ?? ledgerTask?.retries ?? 0,
    durationMs: ledgerTask?.durationMs ?? null,
    file: file === undefined ? null : sanitizeTerminalDisplayText(file),
    ...(target !== undefined && { fileNote: sanitizeTerminalDisplayText(target.note) }),
    ...(target !== undefined && { extraFiles: sanitizeTerminalDisplayText(target.extraFiles) }),
    partialFiles: input.stopped ? input.partialFiles : 0,
  };
}

function rowMethod(
  status: Task['status'] | undefined,
  recorded: TaskCompletionMethod | null,
): TaskCompletionMethod | null {
  if (status === undefined) return recorded;
  if (status === 'done')
    return recorded !== null && classifyTaskCompletionMethod(recorded) === 'local'
      ? recorded
      : 'local';
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
