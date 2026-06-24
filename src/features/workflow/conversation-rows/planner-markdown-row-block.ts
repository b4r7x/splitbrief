import type { Phase } from '../../../core/schemas/enums.js';
import type { ConversationRowBlock, ConversationRowTone } from './types.js';
import { row } from './row-format.js';
import { compositeBlock, rowsBlock } from './row-block-compose.js';
import { markdownConversationRowsProjection } from './markdown-rows.js';

export function markdownPlannerTextRowBlock(input: {
  keyPrefix: string;
  text: string;
  width: number;
  phase?: Phase;
}): ConversationRowBlock | null {
  const projection = markdownConversationRowsProjection({
    keyPrefix: input.keyPrefix,
    text: input.text,
    width: input.width,
  });
  if (projection.rowCount === 0) return null;

  const markdownBlock: ConversationRowBlock = {
    key: input.keyPrefix,
    rowCount: projection.rowCount,
    renderableUnits: 1,
    createRows: projection.createRows,
  };

  const header = plannerPhaseHeader(input.phase);
  if (header === null) return markdownBlock;

  const headerRow = row({
    key: `${input.keyPrefix}-header`,
    text: header.label,
    tone: header.tone,
    bold: true,
    kind: 'message',
  });
  const headerBlock = rowsBlock(`${input.keyPrefix}-header-block`, [headerRow]);
  return compositeBlock(input.keyPrefix, [headerBlock, markdownBlock]);
}

export function plannerPhaseHeader(
  phase: Phase | undefined,
): { label: string; tone: ConversationRowTone } | null {
  switch (phase) {
    case 'specifying':
      return { label: 'SPEC', tone: 'planner' };
    case 'planning':
      return { label: 'PLAN', tone: 'planner' };
    case 'researching':
      return { label: 'RESEARCH', tone: 'planner' };
    case 'escalating':
      return { label: 'ESCALATION', tone: 'warning' };
    default:
      return null;
  }
}
