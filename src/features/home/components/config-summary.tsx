import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import { configStore } from '../../../stores/project/config.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { getProviderDisplayName, isProviderLocal } from '../../../core/providers/catalog.js';
import { formatModelName } from '../../../core/model-display.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { LabeledRow } from '../../../components/labeled-row.js';

const COMPACT_ROWS_THRESHOLD = 30;

export function HomeConfigSummary() {
  const theme = useTheme();
  const [{ rows, isSmall }] = useStores(terminalSizeStore);
  const config = configStore.useConfig();
  const selectedSkillCount = skillsStore.use(s => s.selected.size);
  const plannerToolName = getRunnerDisplayName(config.planner);
  const plannerModel = config.planner.model;
  const implToolName = getRunnerDisplayName(config.implementer);
  const implModel = config.implementer.model;
  const mode = config.workflow.mode ?? 'standard';
  const compact = isSmall || rows < COMPACT_ROWS_THRESHOLD;

  if (compact) {
    const plannerText = plannerModel
      ? `${getProviderDisplayName(plannerToolName)} › ${formatModelName(plannerModel)}`
      : getProviderDisplayName(plannerToolName);
    const implText = `${getProviderDisplayName(implToolName)} › ${formatModelName(implModel)}`;
    return (
      <Box marginBottom={1} flexWrap="wrap">
        <Text color={theme.planner}>{plannerText}</Text>
        <Text color={theme.textDim}>  │  </Text>
        <Text color={theme.implementer}>{implText}</Text>
        {isProviderLocal(implToolName) && (
          <Text color={theme.textDim}> (local)</Text>
        )}
        <Text color={theme.textDim}>  │  </Text>
        <Text color={theme.text}>{mode}</Text>
        {selectedSkillCount > 0 && (
          <>
            <Text color={theme.textDim}>  │  </Text>
            <Text color={theme.accent}>{selectedSkillCount} skills</Text>
          </>
        )}
      </Box>
    );
  }

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
        <Text color={theme.implementer}>{getProviderDisplayName(implToolName)}</Text>
        <Text color={theme.textDim}> › </Text>
        <Text color={theme.implementer}>{formatModelName(implModel)}</Text>
        {isProviderLocal(implToolName) && (
          <Text color={theme.textDim}> (local)</Text>
        )}
        <Text color={theme.textDim}>  /implementer</Text>
      </LabeledRow>
      <LabeledRow label="Mode">
        <Text color={theme.text}>{mode}</Text>
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
