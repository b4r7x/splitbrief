import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { assertNever } from '../../../utils/type-guards.js';
import { buildConversationRowsProjection, materializeConversationRowsWindow } from './build.js';
import type { ConversationRow, ConversationRowsProjection } from './types.js';

interface ProjectionCacheKeyInput {
  sections: Section<EngineEvent>[];
  expandedDiffs: Set<string>;
  expandedActivityBatches: Set<string>;
  cols: number;
  viewportHeight: number;
  streaming: StreamingOutputState;
}

interface ProjectionCacheEntry {
  key: string;
  projection: ConversationRowsProjection;
}

export interface ConversationRowsWindowProjection {
  renderableCount: number;
  rows: ConversationRow[];
  totalRows: number;
  windowStart: number;
  windowEnd: number;
}

let cache: ProjectionCacheEntry | null = null;

export function resetConversationRowsProjectionCache(): void {
  cache = null;
}

export function getConversationRowsProjection(
  input: ProjectionCacheKeyInput,
): ConversationRowsProjection {
  const key = projectionCacheKey(input);
  if (cache?.key === key) return cache.projection;

  const projection = buildConversationRowsProjection({
    sections: input.sections,
    expandedDiffs: input.expandedDiffs,
    expandedActivityBatches: input.expandedActivityBatches,
    cols: input.cols,
    viewportHeight: input.viewportHeight,
    streaming: input.streaming,
  });
  cache = { key, projection };
  return projection;
}

export function getConversationRowsWindowProjection(
  input: ProjectionCacheKeyInput & {
    windowStart: number;
    windowEnd: number;
  },
): ConversationRowsWindowProjection {
  const projection = getConversationRowsProjection(input);
  const start = Math.max(0, input.windowStart);
  const end = Math.max(start, input.windowEnd);
  return {
    renderableCount: projection.renderableCount,
    rows: materializeConversationRowsWindow({ projection, windowStart: start, windowEnd: end }),
    totalRows: projection.totalRows,
    windowStart: start,
    windowEnd: end,
  };
}

function projectionCacheKey(input: ProjectionCacheKeyInput): string {
  return [
    input.cols,
    input.viewportHeight,
    setKey(input.expandedDiffs),
    setKey(input.expandedActivityBatches),
    streamingKey(input.streaming),
    sectionsKey(input.sections),
  ].join('\u0001');
}

function sectionsKey(sections: readonly Section<EngineEvent>[]): string {
  return sections.map(sectionKey).join('\u0002');
}

function sectionKey(section: Section<EngineEvent>): string {
  switch (section.type) {
    case 'completed-task':
      return `completed:${section.startIndex}:${section.summary.index}:${textKey(section.summary.title)}`;
    case 'events':
      return `events:${section.startIndex}:${section.items.length}:${section.items
        .map(eventKey)
        .join('\u0003')}`;
    case 'active-task':
      return `active-task:${section.startIndex}:${section.items.length}:${section.items
        .map(eventKey)
        .join('\u0003')}`;
    default:
      return assertNever(section);
  }
}

function eventKey(event: EngineEvent): string {
  const revision = 'ts' in event ? event.ts : 0;
  const typeSpecific = typeSpecificEventKey(event);
  return `${event.type}:${revision}:${typeSpecific}`;
}

function typeSpecificEventKey(event: EngineEvent): string {
  switch (event.type) {
    case 'runner_call_activity':
      return objectContentKey(event);
    case 'planner_text':
      return [
        event.content ?? 'plain',
        event.phase ?? '',
        event.role ?? '',
        textKey(event.text),
      ].join('\u0004');
    default:
      return objectContentKey(event);
  }
}

function setKey(values: ReadonlySet<string>): string {
  return Array.from(values).sort().join('\u0004');
}

function streamingKey(streaming: StreamingOutputState): string {
  return [
    streaming.active ? 'active' : 'inactive',
    streaming.taskId ?? '',
    streaming.lines.length,
    textKey(streaming.lines.join('\n')),
  ].join('\u0004');
}

function textKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function objectContentKey(value: object): string {
  return textKey(JSON.stringify(value));
}
