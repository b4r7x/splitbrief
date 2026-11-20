import { useTheme } from '../../../components/theme.js';
import { formatPickerStatusLabel } from '../../../core/readiness/cli-remediation.js';
import type { CliReadinessState } from '../../../core/discovery/detection/tool.js';
import type { CrewSeat } from '../../../core/crew/seats.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { assertNever } from '../../../utils/type-guards.js';
import { CREW_IDENTITY_COLUMN } from '../format.js';
import { PresetRowView } from '../preset-row.js';
import { CrewRowView } from '../row-view.js';
import { planListRows, type ListLine } from '../../../components/list-row/plan.js';
import { ListRow } from '../../../components/list-row/row.js';
import type { SetupItem } from './list-plan.js';

type SetupItemRowProps = Readonly<{
  item: SetupItem;
  isCursor: boolean;
  width: number;
  presetLines: readonly ListLine[];
  seatStatuses: ReadonlyMap<CrewSeat['id'], CliReadinessState>;
  canContinue: boolean;
}>;

export function SetupItemRow({
  item,
  isCursor,
  width,
  presetLines,
  seatStatuses,
  canContinue,
}: SetupItemRowProps) {
  const t = useTheme();
  switch (item.kind) {
    case 'preset':
      return <PresetRowView lines={presetLines} isCursor={isCursor} width={width} />;
    case 'crew':
      return (
        <CrewRowView
          row={item.row}
          layout={{ identityWidth: width - CREW_IDENTITY_COLUMN }}
          isCursor={isCursor}
          status={formatPickerStatusLabel({ state: seatStatuses.get(item.row.id) ?? 'ready' })}
        />
      );
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
