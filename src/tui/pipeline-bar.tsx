import { Box, Text } from 'ink';
import type { Phase } from '../types.js';

interface PipelineBarProps {
  phase: Phase;
}

const STAGES = ['res', 'spec', 'plan', 'impl', 'rev'] as const;

export function getStageIndex(phase: Phase): number {
  switch (phase) {
    case 'idle': return -1;
    case 'researching': return 0;
    case 'specifying': case 'reviewing-spec': return 1;
    case 'planning': case 'reviewing-plan': return 2;
    case 'implementing': case 'validating-task': case 'escalating': return 3;
    case 'final-review': return 4;
    case 'complete': return 5;
  }
}

export default function PipelineBar({ phase }: PipelineBarProps) {
  const currentIndex = getStageIndex(phase);

  return (
    <Box>
      {STAGES.map((stage, i) => {
        let symbol: string;
        let color: string;
        if (i < currentIndex) {
          symbol = '●'; color = 'green';
        } else if (i === currentIndex) {
          symbol = '◉'; color = 'yellow';
        } else {
          symbol = '○'; color = 'gray';
        }
        return (
          <Box key={stage}>
            <Text color={color}>{symbol} </Text>
            <Text color={color}>{stage}</Text>
            {i < STAGES.length - 1 && <Text> </Text>}
          </Box>
        );
      })}
    </Box>
  );
}
