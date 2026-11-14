import type { ConversationRowSegment } from '../../conversation-rows/types.js';

export type BuildProgressSpan = Readonly<Pick<ConversationRowSegment, 'text' | 'tone'>>;

export interface BuildProgress {
  passed: number;
  total: number;
  escalated: number;
  failed: number;
  /**
   * The project gate command running at the run base beside the build, with its clock, when the
   * activity line does not already name it.
   */
  base: readonly BuildProgressSpan[] | null;
  /** What the run is doing: the seat and its operation, or the command it is inside. */
  activity: string;
  activitySpans: readonly BuildProgressSpan[];
  activityIdentity: {
    prefix: readonly BuildProgressSpan[];
    identity: BuildProgressSpan;
    suffix: readonly BuildProgressSpan[];
  } | null;
  /**
   * The proof of life: how long the command in `activity` has run, else the silence warning —
   * `No output for <clock>`, then the open tool or the stream hint — else how long ago a seat
   * last said something.
   */
  freshness: string;
  freshnessSpans: readonly BuildProgressSpan[];
  /** True when the watchdog's stall makes freshness the silence warning, not the ordinary age. */
  silent: boolean;
}
