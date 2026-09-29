/** What a partial contributes before it stops being context and starts being noise. */
export const PARTIAL_MAX_CHARS = 8_000;

const DEFAULT_STEER = 'continue from where you left off';

export type ComposeContinuationInput = Readonly<{
  /** The step's own prompt. It leads; the continuation block trails it. */
  basePrompt: string;
  /** Output the interrupted attempt had already produced. */
  partial?: string | undefined;
  /** What the operator typed when they resumed. */
  steer?: string | undefined;
  /** Seat-specific facts the next attempt needs, e.g. files already changed. */
  extra?: string | undefined;
}>;

function trimPartial(partial: string): string {
  if (partial.length <= PARTIAL_MAX_CHARS) return partial;
  return `…${partial.slice(partial.length - PARTIAL_MAX_CHARS)}`;
}

/**
 * The step's real prompt plus a trailing note about the attempt that was cut.
 * A continuation never replaces the prompt: the seat is doing the same step, so
 * it must still be told what the step is.
 */
export function composeContinuation(input: ComposeContinuationInput): string {
  return `${input.basePrompt}\n\n${continuationBlock(input)}`;
}

const NO_EARLIER_OUTPUT = 'No output from an earlier attempt of this step is available.';

/** The trailing note on its own, for a caller that appends it somewhere else. */
export function continuationBlock(input: Omit<ComposeContinuationInput, 'basePrompt'>): string {
  const partial = input.partial?.trim() ?? '';
  const extra = input.extra?.trim() ?? '';
  const steer = input.steer?.trim() || DEFAULT_STEER;
  // A correction typed at a halt travels in this block too, so only an attempt
  // that left output is called interrupted.
  if (partial === '' && extra === '') {
    return `[Continuation] ${NO_EARLIER_OUTPUT} The user says: ${steer}`;
  }
  const blocks = [
    partial === ''
      ? `[Continuation] ${NO_EARLIER_OUTPUT}`
      : '[Continuation] The previous attempt of this step was interrupted.',
  ];
  if (partial !== '') blocks.push(`Partial output so far:\n${trimPartial(partial)}`);
  if (extra !== '') blocks.push(extra);
  blocks.push(`The user says: ${steer}`);
  return blocks.join('\n\n');
}
