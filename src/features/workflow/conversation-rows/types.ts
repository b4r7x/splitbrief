import type { ReactNode } from 'react';
import type { Section } from '../../../core/sections/types.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import type { TextTone } from '../../../core/theme/tone-color.js';

export type ConversationRowTone = TextTone;

export type ConversationRowKind =
  | 'message'
  | 'prompt'
  | 'card'
  | 'card-top'
  | 'card-body'
  | 'card-bottom'
  | 'callout-top'
  | 'callout-body'
  | 'activity'
  | 'activity-child'
  | 'activity-child-last'
  | 'activity-more'
  | 'task-header'
  | 'diff-header'
  | 'diff-line'
  | 'spacer'
  | 'section'
  | 'summary';

export interface ConversationRowSegment {
  text: string;
  tone: ConversationRowTone;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  href?: string;
}

export interface ConversationRow {
  key: string;
  kind: ConversationRowKind;
  segments: ConversationRowSegment[];
  markerTone?: ConversationRowTone;
  /**
   * A settled row that does not wear the done mark: a stop cut its call (`cancelled`), its
   * outcome needs the reader (`attention`), or it holds a failure (`failed`).
   */
  doneAs?: 'cancelled' | 'attention' | 'failed';
  headerContinuation?: boolean;
  codeBg?: true;
  /**
   * A row the transcript paints as given, marker and segments both skipped. It is how a block that
   * already has its own single-line renderer joins the one scroller. Settled summaries receive
   * focus through a renderer; the closed run's ledger carries prebuilt nodes.
   */
  node?: ReactNode | ((focused?: boolean) => ReactNode);
}

export interface ConversationRowBlock {
  key: string;
  rowCount: number;
  renderableUnits: number;
  activeRowKey?: string;
  /**
   * The rows the block takes after its fold flips. A block at the tail of the transcript states
   * it, so a toggle can place the view before the block changes height.
   */
  toggledRowCount?: number;
  /**
   * The key of the row that folds the block, when it has one. The lowest such row of the
   * transcript names the activity key, and a click on any of them toggles its own block.
   */
  foldRowKey?: string;
  createRows: (windowStart: number, windowEnd: number) => ConversationRow[];
}

export interface ConversationRowsProjection {
  activeTaskHeaderKey: string | null;
  blocks: ConversationRowBlock[];
  /** The diff toggle key of the last row that takes one (`diffToggleKey`), or null. */
  latestDiffKey: string | null;
  renderableCount: number;
  totalRows: number;
}

export interface ConversationRowScrollComputation {
  activeTaskHeaderKey: string | null;
  activeRowKey: string | null;
  maxOffset: number;
  newEventCount: number;
  renderableCount: number;
  rows: ConversationRow[];
  scrollOffset: number;
  totalDynamicHeight: number;
  viewportHeight: number;
  windowEnd: number;
  windowStart: number;
}

export interface ConversationRowInputs {
  sections: Section<EngineEvent>[];
  expandedDiffs: Set<string>;
  expandedActivityBatches: Set<string>;
  cols: number;
  viewportHeight: number;
  streaming: StreamingOutputState;
}

export interface ConversationRowScrollInputs extends ConversationRowInputs {
  rawScrollOffset: number;
  renderableCountAtScroll: number;
  heightAtScroll: number;
  /** Blocks appended after the last event, such as the summary of a closed run. */
  tail?: readonly ConversationRowBlock[] | undefined;
}

export interface RowBuildContext {
  width: number;
  viewportRows: number;
  streaming: StreamingOutputState;
}
