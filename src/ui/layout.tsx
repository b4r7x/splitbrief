import { useRef } from 'react';
import { Box, useInput, useStdout, useApp } from 'ink';
import Header from './header.js';
import ConversationFlow from './conversation-flow.js';
import type { ConversationFlowHandle } from './conversation-flow.js';
import CostFooter from './cost-footer.js';
import type { Phase, TuiEvent } from '../types.js';
import { getTheme } from '../theme.js';

export interface LayoutProps {
  feature: string;
  startedAt: string;
  phase: Phase;
  events: TuiEvent[];
  currentTask: number;
  totalTasks: number;
  model: string;
  localRate: number;
  estimatedCost: number;
  estimatedSavings: number;
}

export default function Layout({
  feature,
  startedAt,
  phase,
  events,
  currentTask,
  totalTasks,
  model,
  localRate,
  estimatedCost,
  estimatedSavings,
}: LayoutProps) {
  const { stdout } = useStdout();
  const { exit } = useApp();
  const flowRef = useRef<ConversationFlowHandle>(null);

  const rows = stdout?.rows ?? 24;
  const contentHeight = Math.max(0, rows - 4);

  useInput((input, key) => {
    if (input === 'q') {
      exit();
    } else if (input === 'd') {
      flowRef.current?.toggleDiff();
    } else if (key.upArrow) {
      flowRef.current?.scrollUp();
    } else if (key.downArrow) {
      flowRef.current?.scrollDown();
    }
  });

  return (
    <Box flexDirection="column" height={rows}>
      <Header feature={feature} startedAt={startedAt} phase={phase} />

      <ConversationFlow ref={flowRef} events={events} height={contentHeight} />

      <CostFooter
        currentTask={currentTask}
        totalTasks={totalTasks}
        localRate={localRate}
        estimatedCost={estimatedCost}
        estimatedSavings={estimatedSavings}
        implementerModel={model}
      />
    </Box>
  );
}
