import { formatResetNote } from '../../../core/recovery/reset-clock.js';
import { SOFT_SEP } from '../../../core/separators.js';

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
