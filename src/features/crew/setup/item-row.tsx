import { Box } from 'ink';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import type { CrewSeat } from '../../../core/crew/seats.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { assertNever } from '../../../utils/type-guards.js';
import { CREW_IDENTITY_COLUMN, type SeatBlockLayout } from '../format.js';
import { PresetRowView } from '../preset-row.js';
import { CrewRowView } from '../row-view.js';
import { continueText, type SetupItem } from './list-plan.js';

type SetupItemRowProps = Readonly<{
  item: SetupItem;
  isCursor: boolean;
  width: number;
  layout: SeatBlockLayout;
  presetLabelWidth: number;
  unavailableSeats: readonly CrewSeat[];
  canContinue: boolean;
}>;

export function SetupItemRow({
  item,
  isCursor,
  width,
  layout,
  presetLabelWidth,
  unavailableSeats,
  canContinue,
}: SetupItemRowProps) {
  const t = useTheme();
  switch (item.kind) {
    case 'preset':
      return (
        <PresetRowView
          preset={item.preset}
          isCursor={isCursor}
          width={width}
          labelWidth={presetLabelWidth}
        />
      );
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
                    posture: false,
                  }
                : layout
            }
            isCursor={isCursor}
            width={width - availabilityWidth}
          />
          {unavailable && <Text color={t.warning}>{'  Unavailable'}</Text>}
        </Box>
      );
    }
    case 'continue':
      return (
        <Text color={isCursor && canContinue ? t.accent : t.textDim} bold={isCursor && canContinue}>
          {continueText(isCursor)}
          {!canContinue && `${SOFT_SEP}choose ready seats`}
        </Text>
      );
    default:
      return assertNever(item);
  }
}
