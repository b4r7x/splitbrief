import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { capitalize } from '../../../utils/capitalize.js';
import { formatTime } from '../../../utils/format-time.js';
import { LabeledRow } from '../../../components/labeled-row.js';

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
        <LabeledRow key={phase} label={capitalize(phase)} labelWidth={labelWidth}>
          <Text color={t.textDim}>{formatTime(duration)}</Text>
        </LabeledRow>
      ))}
    </Box>
  );
}
