import { Box, Text } from 'ink';
import { formatCost } from '../utils/format.js';

interface CostFooterProps {
  currentTask: number;
  totalTasks: number;
  localRate: number;
  estimatedCost: number;
  estimatedSavings: number;
  implementerModel: string;
}

export function rateColor(localRate: number): string {
  if (localRate >= 50) return 'cyan';
  if (localRate >= 25) return 'yellow';
  return 'red';
}

export default function CostFooter({ currentTask, totalTasks, localRate, estimatedCost, estimatedSavings, implementerModel }: CostFooterProps) {
  return (
    <Box width="100%">
      <Text>
        {' '}Task {currentTask}/{totalTasks}
        {' \u2502 '}
      </Text>
      <Text color={rateColor(localRate)}>Local: {Math.round(localRate)}%</Text>
      <Text>
        {' \u2502 '}
        {formatCost(estimatedCost)}
        {' \u2502 '}
      </Text>
      <Text color="green">Saved: ~{formatCost(estimatedSavings)}</Text>
      <Text>
        {' \u2502 '}
        {implementerModel}
      </Text>
    </Box>
  );
}
