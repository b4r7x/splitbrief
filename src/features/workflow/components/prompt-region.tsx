import { Box } from 'ink';
import { isQueuePhase } from '../../../core/phases/roles.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { questionPromptStore } from '../../../stores/prompts/question.js';
import { plainAnswer } from '../hooks/use-input-mode.js';
import type { useWorkflowScreen } from '../hooks/workflow-screen/use-model.js';
import type { usePanels } from '../hooks/workflow-screen/use-panels.js';
import type { useQuestionAnswer } from '../hooks/workflow-screen/use-question-answer.js';
import type { useReviewSelection } from '../hooks/workflow-screen/use-review-selection.js';
import { getChromeContentWidth, WORKFLOW_GUTTER_X } from '../layout/chrome-rows.js';
import { ApprovalPrompt } from './approval-prompt/prompt.js';
import { QuestionPrompt } from './question-prompt.js';

/** The region above the composer: the gate and the plan card, or the question and the recovery. */
export function PromptRegion({
  boxRows,
  cols,
  stopMenuOpen,
  model,
  panels,
  review,
  confirms,
  budgetRows,
  recoveryKey,
  recoveryIssue,
  question,
  keysHeldAbove,
}: {
  boxRows: number;
  cols: number;
  stopMenuOpen: boolean;
  model: Pick<ReturnType<typeof useWorkflowScreen>, 'promptPending' | 'phase' | 'inputMode'>;
  panels: ReturnType<typeof usePanels>;
  review: ReturnType<typeof useReviewSelection>;
  confirms: readonly string[];
  budgetRows: number;
  recoveryKey: string;
  /** Null while no recovery choice is asked. */
  recoveryIssue: RecoveryIssue | null;
  question: ReturnType<typeof useQuestionAnswer>;
  keysHeldAbove: boolean;
}) {
  return (
    <Box
      height={stopMenuOpen || panels.resultMenuOpen ? 0 : boxRows}
      overflow="hidden"
      flexDirection="column"
      flexShrink={0}
      paddingX={WORKFLOW_GUTTER_X}
    >
      {!stopMenuOpen && (model.promptPending || review.artifact !== null) && (
        <ApprovalPrompt
          clampedBoxRows={boxRows}
          focused={panels.gate.focused}
          queues={isQueuePhase(model.phase)}
          {...(review.artifact === null
            ? {}
            : {
                review: {
                  artifact: review.artifact,
                  confirms,
                  budgetRows,
                  selectedIndex: review.selected,
                  draft: review.draft,
                  focused: review.focused,
                },
              })}
        />
      )}
      {!stopMenuOpen && model.inputMode.mode === 'question' && (
        <QuestionPrompt
          key={recoveryKey}
          hint={model.inputMode.hint}
          width={getChromeContentWidth(cols)}
          clampedBoxRows={boxRows}
          recoveryIssue={recoveryIssue}
          recoveryMenuFocused={panels.recovery.focused && !keysHeldAbove}
          onRecoveryFocusChange={panels.recovery.setMenu}
          onRecoveryResolve={(answer) =>
            model.inputMode.resolve({ ...plainAnswer(answer), row: true })
          }
          questions={question.state.questions}
          planner={
            question.structured
              ? {
                  disabled: keysHeldAbove,
                  onAnswer: question.answer,
                  onCompose: question.compose,
                  onDecide: question.decide,
                  onPrevious: () => questionPromptStore.previous(),
                }
              : undefined
          }
        />
      )}
    </Box>
  );
}
