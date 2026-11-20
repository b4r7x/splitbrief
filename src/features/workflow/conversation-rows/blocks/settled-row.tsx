import { TaskSummary } from '../../components/task-summary/view.js';
import { taskTargetParts } from '../../../../core/run-view/brief-labels.js';
import { stageSummaryRow } from '../../components/conversation-flow/stage-summary.js';
import { settledTaskStartedEvent } from '../transcript-walk/walk.js';
import type { SettledTranscriptSection } from '../transcript-walk/types.js';
import type { ConversationRow, ConversationRowBlock } from '../types.js';
import { taskStartedCrewRowBlock } from './task-started.js';

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
        reason={
          section.summary.method === 'skipped' &&
          section.items.some(
            (event) =>
              event.type === 'consult_answered' &&
              event.taskId === section.summary.id &&
              event.action === 'cannot' &&
              section.summary.reason?.startsWith('Planner said:'),
          )
            ? undefined
            : section.summary.reason
        }
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
