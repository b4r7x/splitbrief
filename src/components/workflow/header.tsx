import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { PipelineBar } from './pipeline-bar.js';
import { useTheme } from '../../ui/theme.js';
import { terminalSizeStore } from '../../stores/terminal-size.js';
import { truncate, formatTimeHHMMSS } from '../../utils/format.js';
import { routerStore } from '../../stores/router.js';
import { workflowStore } from '../../stores/workflow.js';

interface HeaderProps {
  startedAt: string;
}

function formatElapsed(startedAt: string): string {
  return formatTimeHHMMSS(Date.now() - new Date(startedAt).getTime());
}

export function Header({ startedAt }: HeaderProps) {
  const { cols, isSmall } = terminalSizeStore.use(s => s);
  const t = useTheme();
  const feature = routerStore.use(s => s.screen === 'workflow' ? s.feature : '');
  const phase = workflowStore.use(s => s.phase);
  const [elapsed, setElapsed] = useState(() => formatElapsed(startedAt));
  const timerWidth = 10;
  const pipelineWidth = isSmall ? 30 : 35;
  const featureWidth = Math.max(8, cols - pipelineWidth - timerWidth - 4);

  useEffect(() => {
    const id = setInterval(() => setElapsed(formatElapsed(startedAt)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <Box width="100%" paddingX={1} justifyContent="space-between">
      <Box width={featureWidth}>
        <Text color={t.text}>{truncate(feature, featureWidth)}</Text>
      </Box>
      <PipelineBar phase={phase} />
      <Box width={timerWidth} justifyContent="flex-end">
        <Text color={t.textDim}>{elapsed}</Text>
      </Box>
    </Box>
  );
}
