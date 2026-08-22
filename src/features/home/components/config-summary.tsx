import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { configStore } from '../../../stores/project/config.js';
import { detectionStore } from '../../../stores/project/detection.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { formatModelName } from '../../../core/model-display.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { getWorkflowMode } from '../../../core/config/accessors/values.js';
import { CHEVRON_SEP, SOFT_SEP } from '../../../components/separators.js';
import { stripTerminalControls } from '../../../utils/display-text.js';

function runnerLabel(toolName: string, model: string | undefined): string {
  const provider = getProviderDisplayName(toolName);
  const modelPart = model ? `${CHEVRON_SEP}${formatModelName(model)}` : '';
  return stripTerminalControls(`${provider}${modelPart}`);
}

export function HomeConfigSummary() {
  const theme = useTheme();
  const config = configStore.useConfig();
  const selectedSkillCount = skillsStore.use((s) => s.selected.size);
  // Runner labels stay dim until the first discovery result ever lands, then
  // light up to their role colors — the identity row itself shows the tools
  // coming online instead of claiming readiness it does not have yet.
  const coldDiscovery = detectionStore.use(
    (s) =>
      s.refresh.readiness.fetchedAt === null &&
      (s.refresh.readiness.refreshing || s.refresh.readiness.outcome === 'failed'),
  );
  const plannerToolName = getRunnerDisplayName(config.planner);
  const plannerModel = config.planner.model;
  const implToolName = getRunnerDisplayName(config.implementer);
  const implModel = config.implementer.model;
  const plannerLabel = runnerLabel(plannerToolName, plannerModel);
  const implLabel = runnerLabel(implToolName, implModel);
  const reviewer = resolveReviewerRunner(config);
  const reviewerLabel =
    reviewer.source === 'configured'
      ? runnerLabel(getRunnerDisplayName(reviewer.runner), reviewer.runner.model)
      : null;
  const mode = getWorkflowMode(config);

  return (
    <Box marginBottom={1} overflow="hidden" flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={coldDiscovery ? theme.textDim : theme.planner}>{plannerLabel}</Text>
        <Text color={theme.textDim}>{SOFT_SEP}</Text>
        <Text color={coldDiscovery ? theme.textDim : theme.implementer}>{implLabel}</Text>
        {reviewerLabel !== null && (
          <>
            <Text color={theme.textDim}>{SOFT_SEP}</Text>
            <Text color={coldDiscovery ? theme.textDim : theme.reviewer}>{reviewerLabel}</Text>
          </>
        )}
        <Text color={theme.textDim}>{SOFT_SEP}</Text>
        <Text color={theme.text}>{mode}</Text>
        {selectedSkillCount > 0 && (
          <>
            <Text color={theme.textDim}>{SOFT_SEP}</Text>
            <Text color={theme.textDim}>{selectedSkillCount} skills</Text>
          </>
        )}
      </Text>
    </Box>
  );
}
