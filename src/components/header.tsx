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
  const { isSmall } = useResponsiveLayout();
  const t = useTheme();
  const [elapsed, setElapsed] = useState(() => formatElapsed(startedAt));
  const maxFeatureLength = isSmall ? 25 : 40;

  useEffect(() => {
    const id = setInterval(() => setElapsed(formatElapsed(startedAt)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <Box width="100%" paddingX={1} justifyContent="space-between">
      <Text color={t.text}>{truncate(feature, maxFeatureLength)}</Text>
      <PipelineBar phase={phase} />
      <Text color={t.textDim}>{elapsed}</Text>
    </Box>
  );
}
