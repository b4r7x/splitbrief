import type { ConsultSeat } from '../../../../core/schemas/consult.js';
import { CREW_SEAT_LABELS, PLANNER_INHERITANCE } from '../../../../core/crew/identity.js';
import type { Task, TaskId } from '../../../../core/schemas/task.js';
import { lineageAttemptsOf, type WorkflowState } from '../../../../core/schemas/workflow.js';
import { uniqueSorted } from '../../../../utils/collections.js';
import { scopePathPatterns } from '../../../../utils/path-patterns.js';
import { consultSeatRunner } from '../../escalation/consult-guidance.js';
import { summarizeText } from './issue.js';

/** `> <package>@<version> <script>`: npm and pnpm print it, then `> <command>`, above a script's output. */
const RUN_BANNER = /^> (?:@[^\s/]+\/)?[^\s@/]+@\S+ \S/;

/** npm and pnpm print a banner pair above a script's real output; it is not the error. */
function stripBannerLines(input: string): string {
  const lines = input.split('\n');
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (RUN_BANNER.test(line)) {
      if ((lines[index + 1] ?? '').startsWith('> ')) index++;
      continue;
    }
    if (line.trim().length > 0) kept.push(line);
  }
  return kept.length > 0 ? kept.join('\n') : input;
}

export function summarizeValidation(opts: { validationSummary?: string | undefined }): {
  detail: string;
  summary: string;
} {
  if (opts.validationSummary !== undefined && opts.validationSummary.trim().length > 0) {
    const summary = summarizeText(stripBannerLines(opts.validationSummary));
    return { detail: `Validation: ${summary}`, summary };
  }

  return {
    detail: 'Validation failed without a reported failing check.',
    summary: 'Validation failed without a reported failing check.',
  };
}

export function attemptDetails(
  attempts: number | undefined,
  maxAttempts: number | undefined,
): string[] {
  if (attempts === undefined && maxAttempts === undefined) return [];
  if (attempts !== undefined && maxAttempts !== undefined && attempts <= maxAttempts) {
    return [`Attempts: ${attempts}/${maxAttempts}`];
  }
  if (attempts !== undefined) return [`Attempts: ${attempts}`];
  return [`Max attempts: ${maxAttempts}`];
}

/**
 * The attempt a halted call ran as on its brief's lineage, out of the lineage's allowance: the
 * `attempt N of M` the transcript showed for that call. A call the lineage booked before the halt
 * is already in `used`.
 */
export function haltAttempts(
  state: Pick<WorkflowState, 'lineages'>,
  task: Pick<Task, 'id' | 'parentId'>,
  opts: { booked: boolean },
): { attempts: number; maxAttempts: number } {
  const { used, allowance } = lineageAttemptsOf(state, task);
  return { attempts: opts.booked ? used : used + 1, maxAttempts: allowance };
}

/** An inherited review follows PLAN until its switch gives REVIEW a separate seat. */
export function reviewSeatDetails(followsPlan: boolean): string[] {
  return followsPlan
    ? [
        `${CREW_SEAT_LABELS.review} ${PLANNER_INHERITANCE.mark}. Switching here gives REVIEW its own seat.`,
      ]
    : [];
}

/** A consult halt names the brief whose consult its seat could not answer. */
export function consultHaltDetails(taskId: TaskId, seat: ConsultSeat): string[] {
  return [`The ${consultSeatRunner(seat)} could not answer the consult for ${taskId}.`];
}

export function taskFiles(task: Task): string[] {
  return uniqueSorted(
    [
      ...task.suggestedFiles,
      ...(task.scope?.inBounds ?? []).flatMap(scopePathPatterns),
      ...(task.scope?.approvedOutOfBounds ?? []).flatMap(scopePathPatterns),
    ],
    { trim: true, nonEmpty: true },
  );
}
