import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { Phase } from '../types.js';
import PipelineBar from './pipeline-bar.js';
import { getTheme } from '../theme.js';

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

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '\u2026' : text;
}

export default function Header({ feature, startedAt, phase }: HeaderProps) {
  const t = getTheme();
  const [elapsed, setElapsed] = useState(() => formatElapsed(startedAt));

  useEffect(() => {
    const id = setInterval(() => setElapsed(formatElapsed(startedAt)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <Box width="100%" paddingX={1} justifyContent="space-between">
      <Text color={t.text}>{truncate(feature, 40)}</Text>
      <PipelineBar phase={phase} />
      <Text color={t.textDim}>{elapsed}</Text>
    </Box>
  );
}
