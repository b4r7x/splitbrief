import { ThemeText as Text, useTheme } from '../../components/theme.js';
import type { ListRowModel } from '../../components/list-row/plan.js';
import type { Theme } from '../../core/theme/palette.js';
import type { CrewLabVerdict } from '../../core/crew/labs.js';
import type { CrewRow } from '../../core/crew/rows.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import { truncateTerminalDisplayText } from '../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';
import { CREW_COLUMN_GAP, CREW_IDENTITY_COLUMN, formatCrewRow } from './format.js';

const VERDICT_WORDS: Readonly<Record<CrewLabVerdict, string>> = {
  'cross-lab': 'reads the diff from another lab',
  'same-lab': 'same lab as the build',
};

function seatHue(theme: Theme, row: CrewRow): string | undefined {
  return theme[CREW_SEAT_ROLES[row.id]];
}

export function crewRowModel(
  row: CrewRow,
  width: number,
  theme: Theme,
  status?: string,
): ListRowModel {
  const statusWidth = status ? getTerminalCellWidth(CREW_COLUMN_GAP + status) : 0;
  const formatted = formatCrewRow({
    row,
    layout: { identityWidth: width - CREW_IDENTITY_COLUMN - statusWidth },
  });
  const identity = `${CREW_COLUMN_GAP}${formatted.content}`;
  return {
    name: formatted.label + identity,
    nameParts: [
      { text: formatted.label, color: seatHue(theme, row), bold: true },
      { text: identity, color: theme.text },
    ],
    trailing: status,
    trailingParts: status ? [{ text: status, tone: 'warning' }] : undefined,
  };
}

export type CrewVerdictLineProps = Readonly<{ verdict: CrewLabVerdict; width: number }>;

export function CrewVerdictLine({ verdict, width }: CrewVerdictLineProps) {
  const t = useTheme();
  const lead = ' '.repeat(CREW_IDENTITY_COLUMN);
  return (
    <Text color={t.textDim}>
      {`${lead}${truncateTerminalDisplayText(VERDICT_WORDS[verdict], width - CREW_IDENTITY_COLUMN)}`}
    </Text>
  );
}
