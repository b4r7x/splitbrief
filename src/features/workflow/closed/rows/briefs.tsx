import type { ScrollableDocumentRow } from '../../../../components/scrollable-document.js';
import type { SummaryView } from '../view-model.js';
import { RuleHeader } from '../../../../components/rule-header.js';
import { TaskSummary } from '../../../../components/task-summary.js';
import { briefRowParts } from '../copy.js';

/**
 * The ledger, in plan order: one row per brief the planner compiled, settled or not. It is the
 * same grammar the transcript settles a brief with, so a finished run reads like the run did.
 */
export function briefsSectionRows(
  input: Readonly<{ view: SummaryView; width: number }>,
): ScrollableDocumentRow[] {
  const { view, width } = input;
  const rows: ScrollableDocumentRow[] = [
    { key: 'briefs-heading', node: <RuleHeader label="Briefs" width={width} /> },
  ];
  for (const row of view.briefs.rows) {
    rows.push({
      key: `brief:${row.id}`,
      node: <TaskSummary width={width} {...briefRowParts({ row })} />,
    });
  }
  return rows;
}
