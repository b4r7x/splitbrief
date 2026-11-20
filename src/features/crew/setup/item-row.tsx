import { Box } from 'ink';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import type { CrewSeat } from '../../../core/crew/seats.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { assertNever } from '../../../utils/type-guards.js';
import { CREW_IDENTITY_COLUMN, type SeatBlockLayout } from '../format.js';
import { PresetRowView } from '../preset-row.js';
import { CrewRowView } from '../row-view.js';
import { planListRows, type ListLine } from '../../../components/list-row/plan.js';
import { ListRow } from '../../../components/list-row/row.js';
import type { SetupItem } from './list-plan.js';

type SetupItemRowProps = Readonly<{
  item: SetupItem;
  isCursor: boolean;
  width: number;
  layout: SeatBlockLayout;
  presetLines: readonly ListLine[];
  unavailableSeats: readonly CrewSeat[];
  canContinue: boolean;
}>;

export function SetupItemRow({
  item,
  isCursor,
  width,
  layout,
  presetLines,
  unavailableSeats,
  canContinue,
}: SetupItemRowProps) {
  const t = useTheme();
  switch (item.kind) {
    case 'preset':
      return <PresetRowView lines={presetLines} isCursor={isCursor} width={width} />;
    case 'crew': {
      const unavailable = unavailableSeats.some((seat) => seat.id === item.row.id);
      const availabilityWidth = unavailable ? getTerminalCellWidth('  Unavailable') : 0;
      return (
        <Box>
          <CrewRowView
            row={item.row}
            layout={
              unavailable
                ? {
                    ...layout,
                    identityWidth: width - availabilityWidth - CREW_IDENTITY_COLUMN,
                  }
                : layout
            }
            isCursor={isCursor}
          />
          {unavailable && <Text color={t.warning}>{'  Unavailable'}</Text>}
        </Box>
      );
    }
    case 'continue': {
      const name = 'Continue' + (canContinue ? '' : SOFT_SEP + 'choose ready seats');
      const [line] = planListRows(
        [
          {
            name,
            nameParts: [
              {
                text: name,
                color: isCursor && canContinue ? t.accent : t.textDim,
                bold: isCursor && canContinue,
              },
            ],
          },
        ],
        { width },
      );
      return line && <ListRow line={line} selected={isCursor} width={width} />;
    }
    default:
      return assertNever(item);
  }
}
