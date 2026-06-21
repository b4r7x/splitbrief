import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';

export type ConversationRowTone =
  | 'text'
  | 'textDim'
  | 'accent'
  | 'planner'
  | 'implementer'
  | 'validator'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'markdownHeading'
  | 'markdownCode'
  | 'markdownBlockquote'
  | 'markdownList'
  | 'markdownRule'
  | 'reviewFile';

export type ConversationRowKind =
  | 'message'
  | 'card'
  | 'activity'
  | 'activity-child'
  | 'task-header'
  | 'diff-header'
  | 'diff-line'
  | 'spacer'
  | 'section'
  | 'summary';

export interface ConversationRowSegment {
  text: string;
  tone?: ConversationRowTone;
  bold?: boolean;
  italic?: boolean;
}

export interface ConversationRow {
  key: string;
  kind: ConversationRowKind;
  segments: ConversationRowSegment[];
}

export interface ConversationRowsResult {
  rows: ConversationRow[];
  renderableCount: number;
}

export interface ConversationRowBlock {
  key: string;
  rowCount: number;
  renderableUnits: number;
  createRows: (windowStart: number, windowEnd: number) => ConversationRow[];
}

export interface ConversationRowsProjection {
  blocks: ConversationRowBlock[];
  renderableCount: number;
  totalRows: number;
}

export interface ConversationRowScrollComputation {
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
}

export interface RowBuildContext {
  width: number;
  viewportRows: number;
  streaming: StreamingOutputState;
}
