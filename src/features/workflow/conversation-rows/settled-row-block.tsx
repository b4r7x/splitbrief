import { TaskSummary } from '../../../components/task-summary.js';
import { taskTargetParts } from '../../../stores/workflow/tasks.js';
import { stageSummaryRow } from '../components/conversation-flow/stage-summary.js';
import { settledTaskStartedEvent, type SettledTranscriptSection } from './transcript-walk.js';
import type { ConversationRow, ConversationRowBlock } from './types.js';
import { taskStartedCrewRowBlock } from './task-started-row-block.js';

export interface SettledRowBlockOptions {
  section: SettledTranscriptSection;
  width: number;
}

export function settledRowBlock({ section, width }: SettledRowBlockOptions): ConversationRowBlock {
  const key = `settled-${section.startIndex}`;
  const started = section.type === 'completed-task' ? settledTaskStartedEvent(section) : undefined;
  const target = started === undefined ? undefined : taskTargetParts(started);
  const node = (focused?: boolean) =>
    section.type === 'completed-task' ? (
      <TaskSummary
        width={width}
        focused={focused}
        id={section.summary.id}
        title={section.summary.title}
        state={{ kind: 'settled', method: section.summary.method }}
        retries={section.summary.retries}
        duration={section.summary.duration}
        file={target === undefined || target.path === '' ? section.summary.file : target.path}
        fileNote={target?.note}
        extraFiles={target?.extraFiles}
        reason={section.summary.reason}
      />
    ) : (
      <TaskSummary width={width} focused={focused} {...stageSummaryRow(section.summary)} />
    );

  const row: ConversationRow = {
    key,
    kind: 'summary',
    segments: [],
    node,
  };
  const crew =
    started === undefined
      ? null
      : taskStartedCrewRowBlock({
          keyPrefix: `event-${section.startIndex + section.items.indexOf(started)}-${started.type}`,
          event: started,
          width,
        });
  const rows = [row, ...(crew?.createRows(0, crew.rowCount) ?? [])];

  return {
    key,
    rowCount: rows.length,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) => rows.slice(windowStart, windowEnd),
  };
}
