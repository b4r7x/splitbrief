import { Box, Text } from 'ink';
import { formatCost } from '../utils/format.js';
import { useAppContext } from '../app.js';
import type { Theme } from '../theme.js';

interface CostFooterProps {
  currentTask: number;
  totalTasks: number;
  localRate: number;
  estimatedCost: number;
  estimatedSavings: number;
  implementerModel: string;
  isSmall?: boolean;
}

export function rateColor(localRate: number, t: { success: string; warning: string; error: string }): string {
  if (localRate >= 50) return t.success;
  if (localRate >= 25) return t.warning;
  return t.error;
}

export function renderCostFooter({ currentTask, totalTasks, localRate, estimatedCost, estimatedSavings, implementerModel, isSmall }: CostFooterProps, t: Theme) {
  return (
    <Box width="100%" paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text color={t.text}>Task {currentTask}/{totalTasks}</Text>
        <Text color={rateColor(localRate, t)}>Local: {Math.round(localRate)}%</Text>
        {!isSmall && (
          <>
            <Text color={t.text}>{formatCost(estimatedCost)}</Text>
            <Text color={t.success}>Saved: ~{formatCost(estimatedSavings)}</Text>
          </>
        )}
        <Text color={t.textDim}>{implementerModel}</Text>
      </Box>
      <Text color={t.textDim}>ctrl+b budget</Text>
    </Box>
  );
}

export default function CostFooter(props: CostFooterProps) {
  const { theme: t } = useAppContext();
  return renderCostFooter(props, t);
}
