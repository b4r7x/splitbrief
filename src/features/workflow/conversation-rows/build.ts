import type { EngineEvent } from '../../../engine/events/types.js';
import { diffEventKey } from '../../../core/sections/event-sections.js';
import type {
  ConversationRow,
  ConversationRowInputs,
  ConversationRowsResult,
  RowBuildContext,
} from './types.js';
import { blankRow } from './row-format.js';
import { eventRows } from './event-rows.js';

const MIN_ROW_WIDTH = 1;

const rowCache = new WeakMap<EngineEvent, Map<string, ConversationRow[]>>();

function isVolatileEvent(event: EngineEvent, expanded: boolean): boolean {
  if (event.type === 'implementer_generate_running') return true;
  return event.type === 'implementer_generate_done' && expanded;
}

function cachedEventRows(
  event: EngineEvent,
  globalIndex: number,
  ctx: RowBuildContext,
  expanded: boolean,
): ConversationRow[] {
  if (isVolatileEvent(event, expanded)) {
    return eventRows({ event, globalIndex, ctx, expanded });
  }
  let byKey = rowCache.get(event);
  if (!byKey) {
    byKey = new Map();
    rowCache.set(event, byKey);
  }
  const key = `${ctx.width}|${expanded ? 1 : 0}|${globalIndex}`;
  const cached = byKey.get(key);
  if (cached) return cached;
  const computed = eventRows({ event, globalIndex, ctx, expanded });
  byKey.set(key, computed);
  return computed;
}

export function buildConversationRows(inputs: ConversationRowInputs): ConversationRowsResult {
  const rows: ConversationRow[] = [];
  let renderableCount = 0;
  const ctx: RowBuildContext = {
    width: Math.max(MIN_ROW_WIDTH, inputs.cols),
    viewportRows: inputs.viewportHeight,
    streaming: inputs.streaming,
  };

  for (const section of inputs.sections) {
    if (section.type === 'completed-task') continue;
    for (const [index, event] of section.items.entries()) {
      const globalIndex = section.startIndex + index;
      const eventRowList = cachedEventRows(
        event,
        globalIndex,
        ctx,
        inputs.expandedDiffs.has(diffEventKey(event)),
      );
      if (eventRowList.length === 0) continue;
      if (rows.length > 0) rows.push(blankRow(`spacer-${globalIndex}`));
      rows.push(...eventRowList);
      renderableCount++;
    }
  }

  return { rows, renderableCount };
}
