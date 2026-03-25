import React from 'react';
import { Box, Text } from 'ink';
import type { Phase } from '../types.js';

interface StatusBarProps {
  phase: Phase;
  currentTask: number;
  totalTasks: number;
  model: string;
  retries: number;
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

function StatusBar({ phase, currentTask, totalTasks, model, retries }: StatusBarProps) {
  const { color, bold } = phaseColor(phase);

  return (
    <Box width="100%">
      <Text color={color} bold={bold}>
        {' '}Phase: {phase} {'\u2502'} Task: {currentTask}/{totalTasks} {'\u2502'} Model: {model} {'\u2502'} Retries: {retries}
      </Text>
    </Box>
  );
}

export default StatusBar;
