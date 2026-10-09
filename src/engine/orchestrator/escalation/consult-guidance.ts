import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
import type { ConsultSeat } from '../../../core/schemas/consult.js';
import { truncateByChars } from '../../../utils/truncate.js';

/** The runner a consult seat names in copy: the planner on the plan seat, the reviewer on the review seat. */
export function consultSeatRunner(seat: ConsultSeat): 'planner' | 'reviewer' {
  return seat === 'review' ? 'reviewer' : 'planner';
}

/** The consult seat's guidance as the next attempt's instructions, its context attached. */
export function guidanceInstructions(instructions: string, context: string | null): string {
  const attached = context?.trim() ?? '';
  return attached === '' ? instructions : `${instructions}\n\n${attached}`;
}

/** The error block the one post-consult attempt retries with, under the seat that answered. */
export function consultAttemptError(
  lastError: string,
  instructions: string,
  seat: ConsultSeat,
): string {
  return truncateByChars(
    `${lastError}\n\n## Guidance from the ${consultSeatRunner(seat)}:\n${instructions}`,
    BOUNDS.consultFailingOutputChars,
  );
}
