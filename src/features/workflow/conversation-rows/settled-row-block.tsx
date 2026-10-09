import { TaskSummary } from '../../../components/task-summary.js';
import { stageSummaryRow } from '../components/conversation-flow/stage-summary.js';
import type { SettledTranscriptSection } from './transcript-walk.js';
import type { ConversationRow, ConversationRowBlock } from './types.js';

export interface SettledRowBlockOptions {
  section: SettledTranscriptSection;
  width: number;
}

export function settledRowBlock({ section, width }: SettledRowBlockOptions): ConversationRowBlock {
  const key = `settled-${section.startIndex}`;
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
        file={section.summary.file}
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

  return {
    key,
    rowCount: 1,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) => [row].slice(windowStart, windowEnd),
  };
}
