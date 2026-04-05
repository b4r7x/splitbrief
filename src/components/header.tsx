import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { Phase } from '../types.js';
import PipelineBar from './pipeline-bar.js';
import { useTheme } from '../ui/theme.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { truncate } from '../utils/format.js';

interface HeaderProps {
  feature: string;
  startedAt: string;
  phase: Phase;
}

function formatElapsed(startedAt: string): string {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const h = String(Math.floor(diff / 3600)).padStart(2, '0');
  const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
  const s = String(diff % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export default function Header({ feature, startedAt, phase }: HeaderProps) {
  const { cols, isSmall } = useResponsiveLayout();
  const t = useTheme();
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
