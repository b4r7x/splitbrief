import { PLAN_FILE, TASKS_FILE } from '../../../../core/paths.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { planSegments } from '../../closed/copy/stage-facts.js';
import { wrapWidthFor } from '../row-format/markers.js';
import { segmentedRow } from '../row-format/rows.js';
import { countLed, fitRow, treeBlock, treeLines, treeRow } from '../row-format/tree.js';
import type { ConversationRowBlock } from '../types.js';

export function planCompiledRowBlock(
  key: string,
  event: EngineEventOf<'plan_compiled'>,
  width: number,
): ConversationRowBlock {
  const title = event.changed ? 'Plan changed' : 'Plan ready';
  const facts = planSegments({ plannedBriefs: event.briefs, planCriteria: event.criteria });
  const counts = fitRow(facts.map(countLed), wrapWidthFor('activity', width) - title.length - 2);
  const header = segmentedRow(
    key,
    [
      { text: title, tone: CREW_SEAT_ROLES.plan, bold: true },
      ...(counts.length ? [{ text: '  ', tone: 'textDim' as const }, ...counts] : []),
    ],
    'activity',
  );
  const lines = treeLines(
    [
      { label: 'Goal', hang: 0, segments: [{ text: event.summary, tone: 'text' }] },
      {
        label: 'Files',
        segments: [
          { text: PLAN_FILE, path: event.planPath, tone: 'reviewFile' },
          { text: TASKS_FILE, path: event.tasksPath, tone: 'reviewFile' },
        ],
      },
    ],
    width,
  );
  return treeBlock(
    key,
    [
      header,
      ...lines.map((line, index) => treeRow(`${key}:${index}`, line, index === lines.length - 1)),
    ],
    1,
  );
}
