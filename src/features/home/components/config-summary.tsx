import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import { configStore } from '../../../stores/project/config.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { getProviderDisplayName, isProviderLocal } from '../../../core/providers/catalog.js';
import { formatModelName } from '../../../core/model-display.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { getWorkflowMode } from '../../../core/config/accessors/values.js';
import { LabeledRow } from '../../../components/labeled-row.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { CONFIG_SUMMARY_COMPACT_ROWS } from '../layout.js';

function runnerLabel(toolName: string, model: string | undefined, local = false): string {
  const provider = getProviderDisplayName(toolName);
  const modelPart = model ? ` › ${formatModelName(model)}` : '';
  const localPart = local ? ' (local)' : '';
  return `${provider}${modelPart}${localPart}`;
}

export function HomeConfigSummary() {
  const theme = useTheme();
  const [{ rows, isSmall }] = useStores(terminalSizeStore);
  const config = configStore.useConfig();
  const selectedSkillCount = skillsStore.use((s) => s.selected.size);
  const plannerToolName = getRunnerDisplayName(config.planner);
  const plannerModel = config.planner.model;
  const implToolName = getRunnerDisplayName(config.implementer);
  const implModel = config.implementer.model;
  const implIsLocal = isProviderLocal(implToolName);
  const plannerLabel = runnerLabel(plannerToolName, plannerModel);
  const implLabel = runnerLabel(implToolName, implModel, implIsLocal);
  const mode = getWorkflowMode(config);
  const compact = isSmall || rows < CONFIG_SUMMARY_COMPACT_ROWS;

  if (compact) {
    return (
      <Box marginBottom={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Text color={theme.planner}>{plannerLabel}</Text>
          <Text color={theme.textDim}>{SOFT_SEP}</Text>
          <Text color={theme.implementer}>{implLabel}</Text>
          <Text color={theme.textDim}>{SOFT_SEP}</Text>
          <Text color={theme.text} bold>
            {mode}
          </Text>
          {selectedSkillCount > 0 && (
            <>
              <Text color={theme.textDim}>{SOFT_SEP}</Text>
              <Text color={theme.accent}>{selectedSkillCount} skills</Text>
            </>
          )}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <LabeledRow label="Planner">
        <Box width="100%" height={1} overflow="hidden">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={theme.planner} wrap="truncate-end">
              {plannerLabel}
            </Text>
          </Box>
          <Text color={theme.textDim} wrap="truncate-end">
            {' '}
            /planner
          </Text>
        </Box>
      </LabeledRow>
      <LabeledRow label="Implementer">
        <Box width="100%" height={1} overflow="hidden">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={theme.implementer} wrap="truncate-end">
              {implLabel}
            </Text>
          </Box>
          <Text color={theme.textDim} wrap="truncate-end">
            {' '}
            /implementer
          </Text>
        </Box>
      </LabeledRow>
      <LabeledRow label="Mode">
        <Box width="100%" height={1} overflow="hidden">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={theme.text} wrap="truncate-end">
              {mode}
            </Text>
          </Box>
          <Text color={theme.textDim} wrap="truncate-end">
            {' '}
            /mode
          </Text>
        </Box>
      </LabeledRow>
      {selectedSkillCount > 0 && (
        <LabeledRow label="Skills">
          <Box width="100%" height={1} overflow="hidden">
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text color={theme.accent} wrap="truncate-end">
                {selectedSkillCount} active
              </Text>
            </Box>
            <Text color={theme.textDim} wrap="truncate-end">
              {' '}
              /skills
            </Text>
          </Box>
        </LabeledRow>
      )}
    </Box>
  );
}
