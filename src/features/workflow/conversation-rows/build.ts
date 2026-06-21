import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { diffEventKey } from '../../../core/sections/event-sections.js';
import type {
  ConversationRow,
  ConversationRowInputs,
  ConversationRowsResult,
  RowBuildContext,
} from './types.js';
import { blankRow } from './row-format.js';
import { runnerActivityBatchRows } from './activity-rows.js';
import { activityBatchKey } from './activity-batch-key.js';
import { buildActivityBatchViewModel } from './activity-batch-model.js';
import { eventRows } from './event-rows.js';

const MIN_ROW_WIDTH = 1;

type RunnerActivityEvent = EngineEventOf<'runner_call_activity'>;

interface RunnerActivityBatch {
  callId: string;
  firstIndex: number;
  events: RunnerActivityEvent[];
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

  const appendRows = (
    eventRowList: ConversationRow[],
    globalIndex: number,
    renderableUnits = 1,
  ): void => {
    if (eventRowList.length === 0) return;
    if (rows.length > 0) rows.push(blankRow(`spacer-${globalIndex}`));
    rows.push(...eventRowList);
    renderableCount += renderableUnits;
  };

  const flushActivityBatch = (): void => {
    if (activityBatch === null) return;
    const batchKey = activityBatchKey(activityBatch.firstIndex, activityBatch.callId);
    const model = buildActivityBatchViewModel({
      events: activityBatch.events,
      batchKey,
      expanded: inputs.expandedActivityBatches.has(batchKey),
    });
    appendRows(
      runnerActivityBatchRows({
        model,
        width: ctx.width,
      }),
      activityBatch.firstIndex,
      model.renderableUnits,
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

      const eventRowList = eventRows({
        event,
        globalIndex,
        ctx,
        expanded: inputs.expandedDiffs.has(diffEventKey(event)),
      });
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
