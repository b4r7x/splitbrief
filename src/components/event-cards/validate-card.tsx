import React from 'react';
import { Box, Text } from 'ink';
import type { TuiEvent } from '../../types.js';
import { useTheme } from '../../ui/theme.js';
import { Spinner } from '../../ui/spinner.js';
import { formatDuration } from '../../utils/format.js';

const VALIDATION_STAGES = ['tsc', 'lint', 'test'] as const;
type ValidationStage = typeof VALIDATION_STAGES[number];

interface StagesProps {
  stages: { tsc: boolean; lint: boolean; test: boolean };
  currentStage?: ValidationStage | undefined;
  failedStage?: ValidationStage | undefined;
}

function Stages({ stages, currentStage, failedStage }: StagesProps): React.ReactElement {
  const t = useTheme();
  return (
    <>
      {VALIDATION_STAGES.map(s => {
        const passed = stages[s];
        const failed = s === failedStage;
        const isCurrent = s === currentStage;
        if (passed) return <Box key={s}><Text color={t.textDim}>  {s} </Text><Text color={t.success}>✓</Text></Box>;
        if (failed) return <Box key={s}><Text color={t.textDim}>  {s} </Text><Text color={t.error}>✗</Text></Box>;
        if (isCurrent) return <Box key={s}><Text>  </Text></Box>;
        return <Box key={s}><Text color={t.textDim}>  {s} </Text><Text color={t.textDim}>○</Text></Box>;
      })}
    </>
  );
}

export function ValidateCard({ event }: { event: Extract<TuiEvent, { type: 'validate' }> }) {
  const t = useTheme();

  if (event.status === 'running') {
    const currentStage = VALIDATION_STAGES.find(s => !event.stages[s]) ?? 'test';
    return (
      <Box>
        <Text color={t.validator}>validate</Text>
        <Stages stages={event.stages} currentStage={currentStage} />
        <Spinner label={currentStage} color={t.validator} startTime={event.ts} />
      </Box>
    );
  }

  const dur = event.duration ? `  ${formatDuration(event.duration)}` : '';

  if (event.passed) {
    return (
      <Box>
        <Text color={t.validator}>validate</Text>
        <Stages stages={event.stages} />
        <Text color={t.textDim}>{dur}</Text>
      </Box>
    );
  }

  const failedStage = VALIDATION_STAGES.find(s => !event.stages[s]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.validator}>validate</Text>
        <Stages stages={event.stages} failedStage={failedStage} />
        <Text color={t.textDim}>{dur}</Text>
      </Box>
      {event.error && (
        <Box marginLeft={2}>
          <Text color={t.error}>{event.error}</Text>
        </Box>
      )}
    </Box>
  );
}
