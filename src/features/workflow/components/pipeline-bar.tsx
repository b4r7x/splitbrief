import { Box, Text } from 'ink';
import type { Phase } from '../../../core/schemas/enums.js';
import { assertNever } from '../../../utils/type-guards.js';
import { useTheme } from '../../../components/theme.js';

interface PipelineBarProps {
  phase: Phase;
}

const STAGES = ['res', 'spec', 'plan', 'impl', 'rev'] as const;
const SYMBOL_LABEL_GAP_WIDTH = 1;
const STAGE_GAP_WIDTH = 1;

export const PIPELINE_BAR_WIDTH =
  STAGES.reduce((width, stage) => width + 1 + SYMBOL_LABEL_GAP_WIDTH + stage.length, 0)
  + ((STAGES.length - 1) * STAGE_GAP_WIDTH);

function getStageIndex(phase: Phase): number {
  switch (phase) {
    case 'idle': return -1;
    case 'researching': return 0;
    case 'specifying': case 'reviewing-spec': case 'clarifying': case 'constitution-check': return 1;
    case 'planning': case 'reviewing-plan': case 'reviewing-briefs': case 'analyzing': return 2;
    case 'implementing': case 'validating-task': case 'escalating': return 3;
    case 'final-review': return 4;
    case 'complete': return 5;
    default:
      return assertNever(phase);
  }
}

export function PipelineBar({ phase }: PipelineBarProps) {
  const t = useTheme();
  const currentIndex = getStageIndex(phase);

  return (
    <Box gap={STAGE_GAP_WIDTH}>
      {STAGES.map((stage, i) => {
        const { symbol, color } =
          i < currentIndex ? { symbol: '●', color: t.success }
          : i === currentIndex ? { symbol: '◉', color: t.accent }
          : { symbol: '○', color: t.textDim };
        const labelColor = i === currentIndex && stage === 'impl' ? t.implementer : color;
        return (
          <Box key={stage} gap={SYMBOL_LABEL_GAP_WIDTH}>
            <Text color={color}>{symbol}</Text>
            <Text color={labelColor}>{stage}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
