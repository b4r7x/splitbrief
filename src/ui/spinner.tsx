import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner({ label, color, startTime }: { label: string; color: string; startTime?: number }) {
  const t = useTheme();
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length);
      if (startTime != null) {
        setElapsed(prev => {
          const s = Math.floor((Date.now() - startTime) / 1000);
          return prev === s ? prev : s;
        });
      }
    }, 80);
    return () => clearInterval(id);
  }, [startTime]);

  return (
    <Box>
      <Text color={color}>{SPINNER_FRAMES[frame]}</Text>
      <Text color={color}> {label}</Text>
      {startTime != null && elapsed > 0 && <Text color={color}>  {elapsed}s</Text>}
      {elapsed > 60 && <Text color={t.textDim}>  (still waiting...)</Text>}
    </Box>
  );
}
