import type { TuiEvent } from '../types.js';
import type { DynamicSection } from './event-sections.js';
import { getMaxVisibleDiffLines } from './diff-height.js';

export interface RenderableConversationItem {
  event: TuiEvent;
  globalIndex: number;
  height: number;
  leadingSpacer: boolean;
}

const GUTTER_PADDING = 14;
const CHROME_EVENT_TYPES = new Set<TuiEvent['type']>(['planner-status', 'workflow-config']);

export function isChromeEvent(type: TuiEvent['type']): boolean {
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

type HeightRules = {
  [K in TuiEvent['type']]: (e: Extract<TuiEvent, { type: K }>, ctx: HeightCtx) => number;
};

const HEIGHT_RULES: HeightRules = {
  'planner-status': () => 0,
  'workflow-config': () => 0,
  'planner-text': (e, { cols }) => Math.max(1, visualLineCount(e.text, cols)),
  'task-start': () => 1,
  'task-complete': () => 1,
  'task-skipped': () => 1,
  'implementer-generate-running': () => 1,
  'implementer-generate-done': (e, { rows, diffExpanded }) => {
    if (!e.diff) return 2;
    return diffExpanded ? 1 + estimateExpandedDiffBodyHeight(e.diff, rows) : 2;
  },
  'implementer-generate-failed': () => 1,
  'validate': (e, { cols }) => {
    if (e.status === 'running') return 1;
    return e.error ? 1 + visualLineCount(e.error, cols - 2) : 1;
  },
  'retry': () => 1,
  'escalate': (e, { cols }) => e.hint ? 1 + visualLineCount(e.hint, cols - 2) : 1,
  'git-commit': () => 1,
  'git-checkpoint': () => 1,
  'warning': (e, { cols }) => visualLineCount(`warning  ${e.message}`, cols),
  'error': (e, { cols }) => visualLineCount(`error  ${e.message}`, cols),
  'cost-update': () => 1,
  'cost-prediction': () => 3,
  'budget-warning': () => 1,
  'budget-exceeded': () => 1,
  'workflow-cancelled': () => 2,
  'rewind': () => 1,
  'task-reset': () => 1,
  'message-queued': () => 1,
  'message-injected-native': () => 1,
  'queue-drained': () => 1,
  'queue-cleared': () => 1,
  'user-message': (e, { cols }) => Math.max(1, visualLineCount(e.text, cols)),
};

function applyHeightRule(event: TuiEvent, ctx: HeightCtx): number {
  switch (event.type) {
    case 'planner-status': return HEIGHT_RULES['planner-status'](event, ctx);
    case 'workflow-config': return HEIGHT_RULES['workflow-config'](event, ctx);
    case 'planner-text': return HEIGHT_RULES['planner-text'](event, ctx);
    case 'task-start': return HEIGHT_RULES['task-start'](event, ctx);
    case 'task-complete': return HEIGHT_RULES['task-complete'](event, ctx);
    case 'task-skipped': return HEIGHT_RULES['task-skipped'](event, ctx);
    case 'implementer-generate-running': return HEIGHT_RULES['implementer-generate-running'](event, ctx);
    case 'implementer-generate-done': return HEIGHT_RULES['implementer-generate-done'](event, ctx);
    case 'implementer-generate-failed': return HEIGHT_RULES['implementer-generate-failed'](event, ctx);
    case 'validate': return HEIGHT_RULES['validate'](event, ctx);
    case 'retry': return HEIGHT_RULES['retry'](event, ctx);
    case 'escalate': return HEIGHT_RULES['escalate'](event, ctx);
    case 'git-commit': return HEIGHT_RULES['git-commit'](event, ctx);
    case 'git-checkpoint': return HEIGHT_RULES['git-checkpoint'](event, ctx);
    case 'warning': return HEIGHT_RULES['warning'](event, ctx);
    case 'error': return HEIGHT_RULES['error'](event, ctx);
    case 'cost-update': return HEIGHT_RULES['cost-update'](event, ctx);
    case 'cost-prediction': return HEIGHT_RULES['cost-prediction'](event, ctx);
    case 'budget-warning': return HEIGHT_RULES['budget-warning'](event, ctx);
    case 'budget-exceeded': return HEIGHT_RULES['budget-exceeded'](event, ctx);
    case 'workflow-cancelled': return HEIGHT_RULES['workflow-cancelled'](event, ctx);
    case 'rewind': return HEIGHT_RULES['rewind'](event, ctx);
    case 'task-reset': return HEIGHT_RULES['task-reset'](event, ctx);
    case 'message-queued': return HEIGHT_RULES['message-queued'](event, ctx);
    case 'message-injected-native': return HEIGHT_RULES['message-injected-native'](event, ctx);
    case 'queue-drained': return HEIGHT_RULES['queue-drained'](event, ctx);
    case 'queue-cleared': return HEIGHT_RULES['queue-cleared'](event, ctx);
    case 'user-message': return HEIGHT_RULES['user-message'](event, ctx);
  }
}

export function estimateEventHeight(event: TuiEvent, diffExpanded = false, cols = 80, rows = 24): number {
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
