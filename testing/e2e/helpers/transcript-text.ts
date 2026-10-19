import { createElement, Fragment } from 'react';
import { renderToString } from 'ink';
import { ConversationRowView } from '../../../src/features/workflow/components/conversation-flow/row-view.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import { getSections } from '../../../src/stores/workflow/actions/sections.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';

/** The transcript a replayed run paints, as plain text at 120 columns. */
export function transcriptText(events: Parameters<typeof addEvent>[0][]): string {
  resetWorkflow();
  for (const event of events) addEvent(event);
  const { rows } = buildConversationRows({
    sections: getSections(),
    cols: 120,
    viewportHeight: 200,
    expandedDiffs: new Set(),
    expandedActivityBatches: new Set(),
    streaming: { taskId: null, lines: [], active: false },
  });
  return renderToString(
    createElement(
      Fragment,
      null,
      ...rows.map((row) => createElement(ConversationRowView, { key: row.key, row })),
    ),
  );
}
