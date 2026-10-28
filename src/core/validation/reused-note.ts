import { formatWallClock } from '../../utils/format-time.js';

/**
 * A check result SPLITBRIEF took from an earlier run of the same command on the same files: when
 * that run ran, where a fresh run shows its duration. One spelling for the transcript, the
 * `--plain` line and the review packet.
 */
export function reusedNote(ranAt: string, now: number = Date.now()): string {
  return `reused, ran ${formatWallClock(Date.parse(ranAt), now)}`;
}
