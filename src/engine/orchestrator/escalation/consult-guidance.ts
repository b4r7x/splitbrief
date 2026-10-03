import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
import { truncateByChars } from '../../../utils/truncate.js';

/** The planner's guidance as the next attempt's instructions, its context attached. */
export function guidanceInstructions(instructions: string, context: string | null): string {
  const attached = context?.trim() ?? '';
  return attached === '' ? instructions : `${instructions}\n\n${attached}`;
}

/** The error block the one post-consult attempt retries with. */
export function consultAttemptError(lastError: string, instructions: string): string {
  return truncateByChars(
    `${lastError}\n\n## Guidance from the planner:\n${instructions}`,
    BOUNDS.consultFailingOutputChars,
  );
}
