import { Box, Text } from 'ink';
import { useTheme } from '../../ui/theme.js';
import { configStore } from '../../stores/config.js';
import { skillsStore } from '../../stores/skills.js';
import { getProviderDisplayName, isProviderLocal } from '../../core/providers/catalog.js';
import { formatModelName } from '../../core/providers/models.js';
import { getPlannerToolName } from '../../core/config/planner-config.js';
import { LabeledRow } from '../labeled-row.js';

export function HomeConfigSummary() {
  const theme = useTheme();
  const config = configStore.useConfig();
  const selectedSkillCount = skillsStore.use(s => s.selected.size);
  const plannerToolName = getPlannerToolName(config.planner);
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
        <Text color={theme.implementer}>{getProviderDisplayName(config.implementer.tool)}</Text>
        <Text color={theme.textDim}> › </Text>
        <Text color={theme.implementer}>{formatModelName(config.implementer.model)}</Text>
        {isProviderLocal(config.implementer.tool) && (
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
