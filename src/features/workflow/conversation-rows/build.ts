import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { diffEventKey } from '../../../core/sections/event-sections.js';
import type {
  ConversationRow,
  ConversationRowInputs,
  ConversationRowsResult,
  RowBuildContext,
} from './types.js';
import { blankRow } from './row-format.js';
import { eventRows, runnerActivityBatchRows } from './event-rows.js';

const MIN_ROW_WIDTH = 1;

const rowCache = new WeakMap<EngineEvent, Map<string, ConversationRow[]>>();
type RunnerActivityEvent = EngineEventOf<'runner_call_activity'>;

interface RunnerActivityBatch {
  callId: string;
  firstIndex: number;
  events: RunnerActivityEvent[];
}

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
  let activityBatch: RunnerActivityBatch | null = null;
  const ctx: RowBuildContext = {
    width: Math.max(MIN_ROW_WIDTH, inputs.cols),
    viewportRows: inputs.viewportHeight,
    streaming: inputs.streaming,
  };

  const appendRows = (eventRowList: ConversationRow[], globalIndex: number): void => {
    if (eventRowList.length === 0) return;
    if (rows.length > 0) rows.push(blankRow(`spacer-${globalIndex}`));
    rows.push(...eventRowList);
    renderableCount++;
  };

  const flushActivityBatch = (): void => {
    if (activityBatch === null) return;
    appendRows(
      runnerActivityBatchRows({
        events: activityBatch.events,
        keyPrefix: `activity-batch-${activityBatch.firstIndex}-${activityBatch.callId}`,
        width: ctx.width,
      }),
      activityBatch.firstIndex,
    );
    activityBatch = null;
  };

  for (const section of inputs.sections) {
    if (section.type === 'completed-task') {
      flushActivityBatch();
      continue;
    }
    for (const [index, event] of section.items.entries()) {
      const globalIndex = section.startIndex + index;
      if (event.type === 'runner_call_activity') {
        if (activityBatch !== null && activityBatch.callId === event.callId) {
          activityBatch.events.push(event);
        } else {
          flushActivityBatch();
          activityBatch = { callId: event.callId, firstIndex: globalIndex, events: [event] };
        }
        continue;
      }

      const eventRowList = cachedEventRows(
        event,
        globalIndex,
        ctx,
        inputs.expandedDiffs.has(diffEventKey(event)),
      );
      if (eventRowList.length === 0) {
        if (!belongsToActivityBatch(event, activityBatch)) flushActivityBatch();
        continue;
      }
      flushActivityBatch();
      appendRows(eventRowList, globalIndex);
    }
  }

  flushActivityBatch();
  return { rows, renderableCount };
}

function belongsToActivityBatch(
  event: EngineEvent,
  activityBatch: RunnerActivityBatch | null,
): boolean {
  if (activityBatch === null) return false;
  const callId = runnerCallId(event);
  return callId === activityBatch.callId;
}

function runnerCallId(event: EngineEvent): string | null {
  switch (event.type) {
    case 'runner_call_started':
    case 'runner_call_text_delta':
    case 'runner_call_usage':
    case 'runner_call_tool_use':
    case 'runner_call_activity':
    case 'runner_call_session_id':
    case 'runner_call_artifact':
    case 'runner_call_warning':
    case 'runner_call_error':
    case 'runner_call_completed':
      return event.callId;
    default:
      return null;
  }
}
