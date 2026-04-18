import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { configStore } from '../../../stores/project/config.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { getProviderDisplayName, isProviderLocal } from '../../../core/providers/catalog.js';
import { formatModelName } from '../../../core/model-display.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { LabeledRow } from '../../../components/labeled-row.js';

export function HomeConfigSummary() {
  const theme = useTheme();
  const config = configStore.useConfig();
  const selectedSkillCount = skillsStore.use(s => s.selected.size);
  const plannerToolName = getRunnerDisplayName(config.planner);
  const plannerModel = config.planner.model;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <LabeledRow label="Planner">
        <Text color={theme.planner}>{getProviderDisplayName(plannerToolName)}</Text>
        {plannerModel && (
          <Text color={theme.planner}> › {formatModelName(plannerModel)}</Text>
        )}
        <Text color={theme.textDim}>  /planner</Text>
      </LabeledRow>
      <LabeledRow label="Implementer">
        <Text color={theme.implementer}>{getProviderDisplayName(getRunnerDisplayName(config.implementer))}</Text>
        <Text color={theme.textDim}> › </Text>
        <Text color={theme.implementer}>{formatModelName(config.implementer.model)}</Text>
        {isProviderLocal(getRunnerDisplayName(config.implementer)) && (
          <Text color={theme.textDim}> (local)</Text>
        )}
        <Text color={theme.textDim}>  /implementer</Text>
      </LabeledRow>
      <LabeledRow label="Mode">
        <Text color={theme.text}>{config.workflow.mode ?? 'standard'}</Text>
        <Text color={theme.textDim}>  /mode</Text>
      </LabeledRow>
      {selectedSkillCount > 0 && (
        <LabeledRow label="Skills">
          <Text color={theme.accent}>{selectedSkillCount} active</Text>
          <Text color={theme.textDim}>  /skills</Text>
        </LabeledRow>
      )}
    </Box>
  );
}
