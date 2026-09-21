import { Box } from 'ink';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { useTheme } from '../../../components/theme.js';
import { PromptBody } from './prompt-body.js';
import { QUESTION_PROMPT_HORIZONTAL_CHROME } from '../prompt-rows/question.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { PlannerQuestion } from './planner-question.js';
import { RecoveryMenu } from './recovery-menu.js';

export function QuestionPrompt({
  hint,
  width,
  clampedBoxRows,
  recoveryIssue,
  recoveryMenuFocused,
  onRecoveryFocusChange,
  onRecoveryResolve,
  questions,
  planner,
}: {
  planner?:
    | {
        disabled: boolean;
        onAnswer: (answer: string) => void;
        onCompose: () => void;
        onPrevious: () => void;
      }
    | undefined;
  hint: string;
  width: number;
  clampedBoxRows: number;
  recoveryIssue?: RecoveryIssue | null | undefined;
  recoveryMenuFocused?: boolean | undefined;
  onRecoveryFocusChange?: ((menuFocused: boolean) => void) | undefined;
  onRecoveryResolve?: ((answer: string) => void) | undefined;
  questions?: readonly ClarificationQuestion[] | undefined;
}) {
  const t = useTheme();
  if (
    recoveryIssue !== null &&
    recoveryIssue !== undefined &&
    onRecoveryFocusChange !== undefined &&
    onRecoveryResolve !== undefined
  ) {
    return (
      <RecoveryMenu
        issue={recoveryIssue}
        width={width}
        clampedBoxRows={clampedBoxRows}
        focused={recoveryMenuFocused === true}
        onFocusChange={onRecoveryFocusChange}
        onResolve={onRecoveryResolve}
      />
    );
  }
  if (questions?.length === 0) return null;
  if (questions && questions.length > 0 && planner)
    return <PlannerQuestion width={width} height={clampedBoxRows} {...planner} />;
  const innerWidth = Math.max(1, width - QUESTION_PROMPT_HORIZONTAL_CHROME);
  const innerHeight = Math.max(1, clampedBoxRows - 2);
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle={borderStyleFor('single')}
      borderColor={t.border}
      borderDimColor
      paddingX={1}
      overflow="hidden"
      flexShrink={0}
    >
      <PromptBody prompt={hint} height={innerHeight} width={innerWidth} />
    </Box>
  );
}
