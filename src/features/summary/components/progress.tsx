import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { renderMeterBar } from '../../../utils/meter-bar.js';

interface SummaryProgressProps {
  completed: number;
  total: number;
  completedByLocal: number;
  escalatedToPlanner: number;
  failed: number;
  isSmall: boolean;
}

export function SummaryProgress({
  completed,
  total,
  completedByLocal,
  escalatedToPlanner,
  failed,
  isSmall,
}: SummaryProgressProps) {
  const t = useTheme();

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={t.success}>{renderMeterBar(completed, total, isSmall ? 20 : 30)}</Text>
        <Text>
          {' '}
          {completed}/{total}
        </Text>
      </Box>
      <Box gap={isSmall ? 1 : 2} overflow="hidden">
        <Text color={t.success} wrap="truncate-end">
          {completedByLocal} local
        </Text>
        <Text color={t.warning} wrap="truncate-end">
          {escalatedToPlanner} escalated
        </Text>
        {failed > 0 && (
          <Text color={t.error} wrap="truncate-end">
            {failed} failed
          </Text>
        )}
      </Box>
      <Text color={t.textDim} wrap="truncate-end">
        {isSmall
          ? 'local = cheap · escalated = planner'
          : 'local = cheap implementer, escalated = planner fallback'}
      </Text>
    </Box>
  );
}
