import { useState, useRef } from 'react';
import { Box, Text, useInput, useStdout, useApp } from 'ink';
import Header from './header.js';
import Pane, { type PaneHandle } from './pane.js';
import StatusBar from './status-bar.js';
import ApprovalPrompt from './prompt.js';
import type { Phase } from '../types.js';

export interface LayoutProps {
  feature: string;
  startedAt: string;
  phase: Phase;
  currentTask: number;
  totalTasks: number;
  model: string;
  retries: number;
  plannerLines: string[];
  implementerLines: string[];
  approval?: { type: 'spec' | 'plan'; filePath: string; onApprove: () => void; onReject: () => void; onComment?: (text: string) => void; supportsSession?: boolean } | null;
}

export default function Layout({
  feature,
  startedAt,
  phase,
  currentTask,
  totalTasks,
  model,
  retries,
  plannerLines,
  implementerLines,
  approval,
}: LayoutProps) {
  const [focusedPane, setFocusedPane] = useState<'left' | 'right'>('left');
  const { stdout } = useStdout();
  const { exit } = useApp();

  const leftRef = useRef<PaneHandle>(null);
  const rightRef = useRef<PaneHandle>(null);

  const rows = stdout?.rows ?? 24;
  const paneHeight = rows - 4;

  useInput((input, key) => {
    if (key.tab) {
      setFocusedPane(prev => (prev === 'left' ? 'right' : 'left'));
    } else if (input === 'q' && !approval) {
      exit();
    } else if (key.upArrow) {
      (focusedPane === 'left' ? leftRef : rightRef).current?.scrollUp();
    } else if (key.downArrow) {
      (focusedPane === 'left' ? leftRef : rightRef).current?.scrollDown();
    }
  });

  return (
    <Box flexDirection="column" height={rows}>
      <Header feature={feature} startedAt={startedAt} />

      <Box flexDirection="row" flexGrow={1}>
        <Pane
          ref={leftRef}
          title="Planner"
          lines={plannerLines}
          focused={focusedPane === 'left'}
          height={paneHeight}
          width="50%"
        />
        <Pane
          ref={rightRef}
          title="Implementer"
          lines={implementerLines}
          focused={focusedPane === 'right'}
          height={paneHeight}
          width="50%"
        />
      </Box>

      <StatusBar
        phase={phase}
        currentTask={currentTask}
        totalTasks={totalTasks}
        model={model}
        retries={retries}
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
    </Box>
  );
}
