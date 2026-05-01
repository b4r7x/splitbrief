import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { formatCostGateSummary } from '../../../engine/orchestrator/cost-gate.js';
import { costApprovalStore } from '../../../stores/cost-approval/store.js';
import { closeCostApprovalPrompt } from '../../../stores/cost-approval/actions.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';

interface CostApprovalPromptProps {
  prediction: CostPrediction;
  onApprove: () => void;
  onReject: () => void;
}

export function CostApprovalPrompt({ prediction, onApprove, onReject }: CostApprovalPromptProps) {
  const t = useTheme();
  const summary = formatCostGateSummary(prediction);

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
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color={t.textDim}>Cost estimate unavailable. Proceeding automatically.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="round" borderColor={t.accent}>
      <Text bold color={t.accent}>Cost Approval Required</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>{summary.taskCount} tasks</Text>
          <Text color={t.textDim}> | </Text>
          <Text>Est. </Text>
          <Text bold color={t.success}>{summary.estimatedCost}</Text>
          <Text color={t.textDim}> | </Text>
          <Text>All-planner: </Text>
          <Text color={t.warning}>{summary.allPlannerCost}</Text>
          <Text color={t.textDim}> | </Text>
          <Text>Saving: </Text>
          <Text bold color={t.success}>{summary.estimatedSavings} ({summary.savingsPercentage}%)</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={t.textDim}>Approve? [Y/n] </Text>
      </Box>
    </Box>
  );
}

export function CostApprovalPromptConnected() {
  const state = costApprovalStore.use(s => s);
  if (state.status !== 'pending') return null;
  return (
    <CostApprovalPrompt
      prediction={state.prediction}
      onApprove={() => closeCostApprovalPrompt(true)}
      onReject={() => closeCostApprovalPrompt(false)}
    />
  );
}
