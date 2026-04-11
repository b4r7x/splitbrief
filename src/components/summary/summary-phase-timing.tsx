import { Box, Text } from 'ink';
import { useTheme } from '../../ui/theme.js';
import { formatTime } from '../../utils/format.js';
import { LabeledRow } from '../labeled-row.js';

interface SummaryPhaseTimingProps {
  phaseTimings: Record<string, number>;
  labelWidth: number;
}

export function SummaryPhaseTiming({ phaseTimings, labelWidth }: SummaryPhaseTimingProps) {
  const t = useTheme();
  const entries = Object.entries(phaseTimings);

  if (entries.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Phase Breakdown</Text>
      {entries.map(([phase, duration]) => (
        <LabeledRow
          key={phase}
          label={phase.charAt(0).toUpperCase() + phase.slice(1)}
          labelWidth={labelWidth}
        >
          <Text color={t.textDim}>{formatTime(duration)}</Text>
        </LabeledRow>
      ))}
    </Box>
  );
}
