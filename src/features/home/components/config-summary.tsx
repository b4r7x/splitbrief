import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { configStore } from '../../../stores/project/config.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { formatModelName } from '../../../core/model-display.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
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
  const plannerToolName = getRunnerDisplayName(config.planner);
  const plannerModel = config.planner.model;
  const implToolName = getRunnerDisplayName(config.implementer);
  const implModel = config.implementer.model;
  const plannerLabel = runnerLabel(plannerToolName, plannerModel);
  const implLabel = runnerLabel(implToolName, implModel);
  const mode = getWorkflowMode(config);

  return (
    <Box marginBottom={1} overflow="hidden" flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={theme.planner}>{plannerLabel}</Text>
        <Text color={theme.textDim}>{SOFT_SEP}</Text>
        <Text color={theme.implementer}>{implLabel}</Text>
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
