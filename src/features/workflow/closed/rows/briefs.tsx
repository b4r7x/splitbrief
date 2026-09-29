import type { ScrollableDocumentRow } from '../../../../components/scrollable-document.js';
import type { SummaryView } from '../view-model.js';
import { TaskSummary } from '../../../../components/task-summary.js';
import { briefRowParts } from '../copy.js';
import { LedgerRule } from './lead.js';

/**
 * The ledger, in plan order: one row per brief the planner compiled, settled or not. It is the
 * same grammar the transcript settles a brief with, so a finished run reads like the run did.
 */
export function briefsSectionRows(
  input: Readonly<{ view: SummaryView; width: number; earlier?: boolean }>,
): ScrollableDocumentRow[] {
  const { view, width, earlier = false } = input;
  const label = earlier ? 'Earlier work' : 'Briefs';
  const briefs = earlier ? view.briefs.earlierRows : view.briefs.rows;
  const rows: ScrollableDocumentRow[] = [
    { key: `briefs-heading:${label}`, node: <LedgerRule label={label} width={width} /> },
  ];
  for (const [index, row] of briefs.entries()) {
    rows.push({
      key: `brief:${label}:${index}:${row.id}`,
      node: <TaskSummary width={width} {...briefRowParts({ row })} />,
    });
  }
  return rows;
}
