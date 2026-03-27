import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { Phase } from '../types.js';
import PipelineBar from './pipeline-bar.js';

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
  const [elapsed, setElapsed] = useState(() => formatElapsed(startedAt));

  useEffect(() => {
    const id = setInterval(() => setElapsed(formatElapsed(startedAt)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <Box width="100%" borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderBottom>
      <Text bold color="cyan"> tiny-spec</Text>
      <Text color="gray"> {'\u2502'} </Text>
      <Text>{truncate(feature, 40)}</Text>
      <Text color="gray"> {'\u2502'} </Text>
      <PipelineBar phase={phase} />
      <Text color="gray"> {'\u2502'} </Text>
      <Text>{elapsed}</Text>
    </Box>
  );
}
