import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { SOFT_SEP } from '../../../components/separators.js';

interface SummaryProgressProps {
  completed: number;
  total: number;
  completedByLocal: number;
  failed: number;
  isSmall: boolean;
}

export function SummaryProgress({
  completed,
  total,
  completedByLocal,
  failed,
  isSmall,
}: SummaryProgressProps) {
  const t = useTheme();

  if (total === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={t.textDim}>No task briefs compiled</Text>
        {failed > 0 && <Text color={t.error}>{failed} failed</Text>}
      </Box>
    );
  }

  return (
    <Box marginTop={1} overflow="hidden">
      <Text color={t.textDim} wrap="truncate-end">
        {completed}/{total}
        {isSmall ? '' : ' tasks'}
        {SOFT_SEP}
        {completedByLocal} local
        {failed > 0 ? (
          <Text color={t.error}>
            {SOFT_SEP}
            {failed} failed
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
