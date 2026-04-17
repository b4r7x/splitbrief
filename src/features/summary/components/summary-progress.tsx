import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';

interface SummaryProgressProps {
  completed: number;
  total: number;
  completedByLocal: number;
  escalatedToPlanner: number;
  failed: number;
  isSmall: boolean;
}

function progressBar(completed: number, total: number, width: number): string {
  if (total === 0) return '░'.repeat(width);
  const clamped = Math.min(completed, total);
  const filled = Math.round((clamped / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
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
        <Text color={t.success}>{progressBar(completed, total, isSmall ? 20 : 30)}</Text>
        <Text> {completed}/{total}</Text>
      </Box>
      <Box gap={2}>
        <Text color={t.success}>{completedByLocal} local</Text>
        <Text color={t.warning}>{escalatedToPlanner} escalated</Text>
        {failed > 0 && <Text color={t.error}>{failed} failed</Text>}
      </Box>
    </Box>
  );
}
