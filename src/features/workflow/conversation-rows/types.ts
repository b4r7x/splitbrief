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
  | 'info';

export interface ConversationRowSegment {
  text: string;
  tone?: ConversationRowTone;
  bold?: boolean;
}

export interface ConversationRow {
  key: string;
  segments: ConversationRowSegment[];
}

export interface ConversationRowsResult {
  rows: ConversationRow[];
  renderableCount: number;
}

export interface ConversationRowScrollComputation {
  maxOffset: number;
  newEventCount: number;
  renderableCount: number;
  rows: ConversationRow[];
  scrollOffset: number;
  totalDynamicHeight: number;
  viewportHeight: number;
}

export interface ConversationRowInputs {
  sections: Section<EngineEvent>[];
  expandedDiffs: Set<number>;
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
