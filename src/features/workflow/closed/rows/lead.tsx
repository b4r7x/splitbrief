import { Box } from 'ink';
import { ThemeText as Text } from '../../../../components/theme.js';
import { RuleHeader } from '../../../../components/rule-header.js';
import { rowLeadingCells } from '../../conversation-rows/row-markers.js';

// Every ledger row is a `ConversationRow.node`, which the transcript paints without a `RowLeading`.
// Each row spends this lead itself so its first ink lands on the column the transcript's content
// does, and it is measured off the transcript's own grammar so the two cannot drift apart.
export const LEDGER_LEAD_CELLS = rowLeadingCells('message');

export const LEDGER_LEAD = ' '.repeat(LEDGER_LEAD_CELLS);

/**
 * A ledger rule: the lead, then a rule spanning the cells left inside `width` bar one. A `─` inks
 * its whole cell while the composer's `╮` below turns at the cell's centre, so a rule run to the
 * last column would overhang that stroke by half a cell; it stops one column short instead.
 */
export function LedgerRule({ label, width }: { label: string; width: number }) {
  return (
    <Box>
      <Text>{LEDGER_LEAD}</Text>
      <RuleHeader label={label} width={Math.max(1, width - LEDGER_LEAD_CELLS - 1)} />
    </Box>
  );
}
