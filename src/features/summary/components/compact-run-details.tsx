import { Box, Text } from 'ink';
import type { Summary } from '../../../core/schemas/summary.js';
import { useTheme } from '../../../components/theme.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { formatTime } from '../../../utils/format-time.js';
import { formatScoreSummary } from '../../../core/formatting.js';
import { stripTerminalControls } from '../../../utils/display-text.js';

export function SummaryCompactRunDetails({
  summary,
  routeSummary,
}: {
  summary: Summary;
  routeSummary: string | null;
}) {
  const theme = useTheme();
  const runParts = [
    summary.mode ?? null,
    formatTime(summary.totalTime),
    summary.briefQuality
      ? formatScoreSummary(summary.briefQuality.score, summary.briefQuality, 'quality')
      : null,
    summary.driftSummary
      ? formatScoreSummary(summary.driftSummary.score, summary.driftSummary)
      : null,
  ].filter((part): part is string => part !== null);

  return (
    <Box flexDirection="column" marginTop={1} overflow="hidden">
      <Text wrap="truncate-end">Feature: {stripTerminalControls(summary.feature)}</Text>
      <Text color={theme.textDim} wrap="truncate-end">
        {routeSummary ? `${routeSummary}${SOFT_SEP}` : ''}
        {runParts.join(SOFT_SEP)}
      </Text>
    </Box>
  );
}
