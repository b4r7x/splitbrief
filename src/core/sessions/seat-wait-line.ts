import { CREW_SEAT_LABELS } from '../crew/identity.js';
import { getRunnerIdentityDisplayName } from '../providers/catalog.js';
import { formatResetNote } from '../recovery/reset-clock.js';
import type { SeatWait, WorkflowState } from '../schemas/workflow.js';
import { SOFT_SEP } from '../separators.js';

/**
 * The live wait line as its two parts, the wait and its reset; none once the reset has passed, so
 * the resuming line shows again.
 */
export function seatWaitParts(
  tool: string,
  resetAt: string | undefined,
  now: number = Date.now(),
): readonly [waiting: string, resets: string] | null {
  const at = resetAt === undefined ? Number.NaN : Date.parse(resetAt);
  if (Number.isNaN(at) || at <= now) {
    return null;
  }
  return [`Waiting for ${tool}`, formatResetNote(at, now)];
}

export function seatWaitSentence(
  tool: string,
  resetAt: string | undefined,
  now: number = Date.now(),
): string | null {
  return seatWaitParts(tool, resetAt, now)?.join(SOFT_SEP) ?? null;
}

/**
 * The tool a seat wait waits on, in the catalog's words: the runner the halted call ran on, else,
 * for a wait saved without it, the seat's tool from the run's start. The wait's start event
 * carries it, so the live wait and the stopped run read the same word.
 */
export function seatWaitToolWord(state: WorkflowState, wait: SeatWait): string {
  const started =
    wait.seat === 'plan'
      ? { tool: state.plannerTool, kind: state.plannerKind }
      : wait.seat === 'build'
        ? { tool: state.implementerTool, kind: state.implementerKind }
        : state.reviewerTool !== undefined
          ? { tool: state.reviewerTool, kind: state.reviewerKind }
          : { tool: state.plannerTool, kind: state.plannerKind };
  const ran = wait.tool !== undefined ? { tool: wait.tool, kind: wait.kind } : started;
  return ran.tool === undefined
    ? CREW_SEAT_LABELS[wait.seat]
    : getRunnerIdentityDisplayName(ran.kind, ran.tool);
}
