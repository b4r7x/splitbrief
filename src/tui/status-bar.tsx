import { Box, Text } from 'ink';
import type { Phase } from '../types.js';
import { formatTokens, formatCost } from '../utils/format.js';

interface StatusBarProps {
  phase: Phase;
  currentTask: number;
  totalTasks: number;
  model: string;
  retries: number;
  plannerName?: string;
  totalTokens?: number;
  estimatedCost?: number;
}

function phaseColor(phase: Phase): { color: string; bold?: boolean } {
  switch (phase) {
    case 'idle':
      return { color: 'gray' };
    case 'researching':
    case 'specifying':
    case 'planning':
      return { color: 'blue' };
    case 'reviewing-spec':
    case 'reviewing-plan':
      return { color: 'yellow' };
    case 'implementing':
      return { color: 'green' };
    case 'validating-task':
      return { color: 'cyan' };
    case 'escalating':
      return { color: 'red' };
    case 'final-review':
      return { color: 'magenta' };
    case 'complete':
      return { color: 'green', bold: true };
  }
}

function StatusBar({ phase, currentTask, totalTasks, model, retries, plannerName, totalTokens, estimatedCost }: StatusBarProps) {
  const { color, bold } = phaseColor(phase);

  const plannerSection = plannerName ? ` \u2502 Planner: ${plannerName}` : '';
  const tokensSection = totalTokens && totalTokens > 0
    ? ` \u2502 Tokens: ${formatTokens(totalTokens)} \u2502 ~${formatCost(estimatedCost ?? 0)}`
    : '';

  return (
    <Box width="100%">
      <Text color={color} bold={bold}>
        {' '}Phase: {phase} {'\u2502'} Task: {currentTask}/{totalTasks}{plannerSection} {'\u2502'} Model: {model}{tokensSection} {'\u2502'} Retries: {retries}
      </Text>
    </Box>
  );
}

export default StatusBar;
