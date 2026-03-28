import { useRef, type ReactNode } from 'react';
import { Box, useInput, useStdout, useApp } from 'ink';
import Header from './header.js';
import ConversationFlow from './conversation-flow.js';
import type { ConversationFlowHandle } from './conversation-flow.js';
import CostFooter from './cost-footer.js';
import ApprovalPrompt from './prompt.js';
import type { Phase, TuiEvent } from '../types.js';

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
  approval?: { type: 'spec' | 'plan'; filePath: string; onApprove: () => void; onReject: () => void; onComment?: (text: string) => void; supportsSession?: boolean } | null;
  children?: ReactNode;
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
  approval,
  children,
}: LayoutProps) {
  const { stdout } = useStdout();
  const { exit } = useApp();
  const flowRef = useRef<ConversationFlowHandle>(null);

  const rows = stdout?.rows ?? 24;
  const contentHeight = Math.max(0, rows - 4);

  useInput((input, key) => {
    if (input === 'q' && !approval) {
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

      {approval && (
        <ApprovalPrompt
          type={approval.type}
          filePath={approval.filePath}
          onApprove={approval.onApprove}
          onReject={approval.onReject}
          onComment={approval.onComment}
          supportsSession={approval.supportsSession}
        />
      )}

      {children}
    </Box>
  );
}
