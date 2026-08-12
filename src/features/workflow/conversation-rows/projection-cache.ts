import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { buildConversationRowsProjection } from './build.js';
import { materializeConversationRowsWindow } from './materialize-window.js';
import type {
  ConversationRow,
  ConversationRowInputs,
  ConversationRowsProjection,
} from './types.js';

interface StreamingProjectionKey {
  active: boolean;
  taskId: StreamingOutputState['taskId'];
  lines: string[];
}

interface ProjectionCacheEntry {
  sections: Section<EngineEvent>[];
  expandedDiffs: Set<string>;
  expandedActivityBatches: Set<string>;
  cols: number;
  viewportHeight: number;
  streaming: StreamingProjectionKey;
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
  input: ConversationRowInputs,
): ConversationRowsProjection {
  if (cache !== null && isProjectionCacheHit(cache, input)) return cache.projection;

  const { sections, expandedDiffs, expandedActivityBatches, cols, viewportHeight, streaming } =
    input;
  const projection = buildConversationRowsProjection({
    sections,
    expandedDiffs,
    expandedActivityBatches,
    cols,
    viewportHeight,
    streaming,
  });
  cache = {
    sections,
    expandedDiffs,
    expandedActivityBatches,
    cols,
    viewportHeight,
    streaming: streamingProjectionKey(streaming),
    projection,
  };
  return projection;
}

// Copied by value: useStores hands render callers a Proxy whose reads forward to the live store, so
// retaining the object itself would compare live state against live state and hit forever.
function streamingProjectionKey(streaming: StreamingOutputState): StreamingProjectionKey {
  return { active: streaming.active, taskId: streaming.taskId, lines: streaming.lines };
}

export function getConversationRowsWindowProjection(
  input:
    | (ConversationRowInputs & {
        windowStart: number;
        windowEnd: number;
      })
    | {
        projection: ConversationRowsProjection;
        windowStart: number;
        windowEnd: number;
      },
): ConversationRowsWindowProjection {
  const projection =
    'projection' in input ? input.projection : getConversationRowsProjection(input);
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

// A hit requires the inputs to be reference/primitive-equal. This is sound because upstream
// state never mutates in place: mergeEvent re-allocates the changed event and the events array
// (src/stores/workflow/events.ts), computeSections is identity-cached on that array
// (src/stores/workflow/actions/sections.ts), and the streaming/scroll stores replace their state objects
// on every change.
//
// Streaming is compared field-by-field rather than by object identity: useStores hands components a
// fresh Proxy per render (src/stores/use-stores.ts), so a whole-object check never matched from the
// render path and the transcript was rebuilt on every keypress. The projection reads only these three
// fields (event-rows/execution.ts) and the store replaces `lines` on every change, so comparing them
// is equivalent to comparing the state itself.
function isProjectionCacheHit(entry: ProjectionCacheEntry, input: ConversationRowInputs): boolean {
  return (
    entry.sections === input.sections &&
    entry.expandedDiffs === input.expandedDiffs &&
    entry.expandedActivityBatches === input.expandedActivityBatches &&
    entry.cols === input.cols &&
    entry.viewportHeight === input.viewportHeight &&
    entry.streaming.active === input.streaming.active &&
    entry.streaming.taskId === input.streaming.taskId &&
    entry.streaming.lines === input.streaming.lines
  );
}
