import { Box, Text, useInput } from 'ink';
import { formatCostGateSummary } from '../../../core/cost-gate-summary.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import { useTheme } from '../../../components/theme.js';
import {
  costApprovalStore,
  closeCostApprovalPrompt,
} from '../../../stores/cost-approval/prompt.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getCostApprovalPromptRowsForPrediction } from '../prompt-rows.js';

interface CostApprovalPromptProps {
  prediction: CostPrediction;
  onApprove: () => void;
  onReject: () => void;
}

export function CostApprovalPrompt({ prediction, onApprove, onReject }: CostApprovalPromptProps) {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const summary = formatCostGateSummary(prediction);
  const promptRows = getCostApprovalPromptRowsForPrediction(prediction, cols);

  useInput((input, key) => {
    if (input === 'y' || input === 'Y' || key.return) {
      onApprove();
      return;
    }
    if (input === 'n' || input === 'N' || key.escape) {
      onReject();
      return;
    }
  });

  if (!summary) {
    return (
      <Box
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        height={promptRows}
        width="100%"
        overflow="hidden"
        flexShrink={0}
      >
        <Text color={t.textDim}>Cost estimate unavailable. Proceeding automatically.</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      borderStyle="round"
      borderColor={t.accent}
      height={promptRows}
      width="100%"
      overflow="hidden"
      flexShrink={0}
    >
      <Text bold color={t.accent}>
        Cost Approval Required
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>{summary.taskCount} tasks</Text>
          <Text color={t.textDim}> | </Text>
          <Text>Est. </Text>
          <Text bold color={t.success}>
            {summary.estimatedCost}
          </Text>
          <Text color={t.textDim}> | </Text>
          <Text>All-planner: </Text>
          <Text color={t.warning}>{summary.allPlannerCost}</Text>
          <Text color={t.textDim}> | </Text>
          <Text>Saving: </Text>
          <Text bold color={t.success}>
            {summary.estimatedSavings} ({summary.savingsPercentage}%)
          </Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={t.textDim}>Approve? [Y/n] </Text>
      </Box>
    </Box>
  );
}

export function CostApprovalPromptConnected() {
  const state = costApprovalStore.use((s) => s);
  if (state.status !== 'pending') return null;
  return (
    <CostApprovalPrompt
      prediction={state.prediction}
      onApprove={() => closeCostApprovalPrompt({ approved: true })}
      onReject={() => closeCostApprovalPrompt({ approved: false })}
    />
  );
}
