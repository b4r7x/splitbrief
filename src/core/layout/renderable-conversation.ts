import type { EngineEvent } from '../../engine/events/types.js';
import type { DynamicSection } from './event-sections.js';
import { getMaxVisibleDiffLines } from './diff-height.js';

export interface RenderableConversationItem {
  event: EngineEvent;
  globalIndex: number;
  height: number;
  leadingSpacer: boolean;
}

const GUTTER_PADDING = 14;
const CHROME_EVENT_TYPES = new Set<EngineEvent['type']>(['planner_status', 'workflow_config']);

export function isChromeEvent(type: EngineEvent['type']): boolean {
  return CHROME_EVENT_TYPES.has(type);
}

export function visualLineCount(text: string, width: number): number {
  const effective = Math.max(20, width - GUTTER_PADDING);
  let lines = 0;
  const rawLines = text.split('\n');
  for (const raw of rawLines) {
    const len = raw.length;
    lines += len === 0 ? 1 : Math.ceil(len / effective);
  }
  return lines;
}

function estimateExpandedDiffBodyHeight(diff: string, rows: number): number {
  const maxLines = getMaxVisibleDiffLines(rows);
  const lines = diff.split('\n').filter((line) => line.length > 0);
  const visible = Math.min(lines.length, maxLines);
  const remaining = Math.max(0, lines.length - visible);
  return 1 + visible + (remaining > 0 ? 1 : 0);
}

type HeightCtx = { cols: number; rows: number; diffExpanded: boolean };

function applyHeightRule(event: EngineEvent, ctx: HeightCtx): number {
  const { cols, rows, diffExpanded } = ctx;
  switch (event.type) {
    case 'planner_status': return 0;
    case 'workflow_config': return 0;
    case 'planner_text': return Math.max(1, visualLineCount(event.text, cols));
    case 'task_started': return 1;
    case 'task_completed': return 1;
    case 'task_skipped': return 1;
    case 'implementer_generate_running': return 1;
    case 'implementer_generate_done':
      if (!event.diff) return 2;
      return diffExpanded ? 1 + estimateExpandedDiffBodyHeight(event.diff, rows) : 2;
    case 'implementer_generate_failed': return 1;
    case 'validate':
      if (event.status === 'running') return 1;
      return event.error ? 1 + visualLineCount(event.error, cols - 2) : 1;
    case 'task_retry': return 1;
    case 'escalate': return event.hint ? 1 + visualLineCount(event.hint, cols - 2) : 1;
    case 'git_commit': return 1;
    case 'git_checkpoint': return 1;
    case 'warning': return visualLineCount(`warning  ${event.message}`, cols);
    case 'error': return visualLineCount(`error  ${event.message}`, cols);
    case 'cost_update': return 1;
    case 'cost_prediction': return 3;
    case 'budget_warning': return 1;
    case 'budget_exceeded': return 1;
    case 'workflow_cancelled': return 2;
    case 'rewind_to_spec': return 1;
    case 'rewind_to_plan': return 1;
    case 'task_reset': return 1;
    case 'message_queued': return 1;
    case 'message_injected_native': return 1;
    case 'queue_drained': return 1;
    case 'queue_cleared': return 1;
    case 'user_message': return Math.max(1, visualLineCount(event.text, cols));
    case 'planner_attachment_added': return 1;
    case 'planner_attachments_dropped': return 1;
    default: return 0;
  }
}

export function estimateEventHeight(event: EngineEvent, diffExpanded = false, cols = 80, rows = 24): number {
  return applyHeightRule(event, { cols, rows, diffExpanded });
}

export function getRenderableConversationItems(
  sections: DynamicSection[],
  expandedDiffs: Set<number>,
  cols?: number,
  rows?: number,
): RenderableConversationItem[] {
  const items: RenderableConversationItem[] = [];
  for (const section of sections) {
    for (const [index, event] of section.items.entries()) {
      if (isChromeEvent(event.type)) continue;
      const globalIndex = section.startIndex + index;
      items.push({
        event,
        globalIndex,
        height: estimateEventHeight(event, expandedDiffs.has(globalIndex), cols, rows),
        leadingSpacer: items.length > 0,
      });
    }
  }
  return items;
}

export function estimateRenderableConversationHeight(items: RenderableConversationItem[]): number {
  return items.reduce(
    (sum, item) => sum + item.height + (item.leadingSpacer ? 1 : 0),
    0,
  );
}
