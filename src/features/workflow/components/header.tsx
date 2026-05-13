import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { PipelineBar } from './pipeline-bar.js';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { truncateWithEllipsis } from '../../../utils/truncate.js';
import { formatTimeHHMMSS } from '../../../utils/format-time.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useStores } from '../../../stores/use-stores.js';
import type { Phase } from '../../../core/schemas/enums.js';

interface HeaderProps {
  startedAt: string;
}

function formatElapsed(startedAt: string): string {
  return formatTimeHHMMSS(Date.now() - new Date(startedAt).getTime());
}

function ElapsedClock({ startedAt, phase }: { startedAt: string; phase: Phase }) {
  const t = useTheme();
  const [elapsed, setElapsed] = useState(() => formatElapsed(startedAt));

  useEffect(() => {
    if (phase === 'complete') return;
    const id = setInterval(() => setElapsed(formatElapsed(startedAt)), 1000);
    return () => clearInterval(id);
  }, [startedAt, phase]);

  return <Text color={t.textDim}>{elapsed}</Text>;
}

export function Header({ startedAt }: HeaderProps) {
  const [{ cols, isSmall }, { phase }] = useStores(terminalSizeStore, lifecycleStore);
  const t = useTheme();
  const feature = routerStore.use(s => s.screen === 'workflow' ? s.feature : '');
  const worktreeName = routerStore.use(s => s.screen === 'workflow' ? s.worktreeName : undefined);
  const timerWidth = 10;
  const pipelineWidth = isSmall ? 30 : 35;
  const featureWidth = Math.max(8, cols - pipelineWidth - timerWidth - 4);
  const labelWidth = worktreeName ? worktreeName.length + 3 : 0;

  return (
    <Box width="100%" paddingX={1} justifyContent="space-between">
      <Box width={featureWidth}>
        {worktreeName && <Text color={t.warning}>[{worktreeName}] </Text>}
        <Text color={t.text}>{truncateWithEllipsis(feature, featureWidth - labelWidth)}</Text>
      </Box>
      <PipelineBar phase={phase} />
      <Box width={timerWidth} justifyContent="flex-end">
        <ElapsedClock startedAt={startedAt} phase={phase} />
      </Box>
    </Box>
  );
}
