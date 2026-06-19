import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const STILL_WAITING_THRESHOLD_SECONDS = 60;

type SpinnerProps = {
  label: string;
  color?: string;
} & (
  | { startTime: number; elapsedMs?: never }
  | { elapsedMs: number; startTime?: never }
  | { startTime?: undefined; elapsedMs?: undefined }
);

function elapsedFromStart(startTime: number | undefined): number {
  return startTime == null ? 0 : Math.max(0, Date.now() - startTime);
}

export function Spinner(props: SpinnerProps) {
  const t = useTheme();
  const resolvedColor = props.color ?? t.spinner;
  const { label, startTime, elapsedMs: staticElapsedMs } = props;
  const [frame, setFrame] = useState(0);
  const [liveElapsedMs, setLiveElapsedMs] = useState(() => elapsedFromStart(startTime));
  const elapsedSeconds = Math.floor((staticElapsedMs ?? liveElapsedMs) / 1000);

  useEffect(() => {
    setLiveElapsedMs(elapsedFromStart(startTime));
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      if (startTime != null) {
        setLiveElapsedMs(elapsedFromStart(startTime));
      }
    }, 80);
    return () => clearInterval(id);
  }, [startTime]);

  return (
    <Box>
      <Text color={resolvedColor}>{SPINNER_FRAMES[frame]}</Text>
      <Text color={resolvedColor}> {label}</Text>
      {elapsedSeconds > 0 && <Text color={resolvedColor}> {elapsedSeconds}s</Text>}
      {staticElapsedMs == null &&
        startTime != null &&
        elapsedSeconds > STILL_WAITING_THRESHOLD_SECONDS && (
          <Text color={t.textDim}> (still waiting...)</Text>
        )}
    </Box>
  );
}
