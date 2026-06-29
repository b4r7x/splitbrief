import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { spinnerFrames } from '../../../lib/glyphs.js';
import { useTheme } from '../../../components/theme.js';

// Resolved once per process: the portable line spinner `| / - \` by default, braille only on a
// positively-identified modern host. Ticked at ~120 ms so the line frames read as motion, not strobe.
const SPINNER_FRAMES = spinnerFrames();
const SPINNER_INTERVAL_MS = 120;

type SpinnerProps = {
  label: ReactNode;
  color?: string;
};

export function Spinner({ label, color }: SpinnerProps) {
  const t = useTheme();
  const resolvedColor = color ?? t.spinner;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <Box>
      <Text color={resolvedColor}>{SPINNER_FRAMES[frame]}</Text>
      <Text color={resolvedColor}> {label}</Text>
    </Box>
  );
}
