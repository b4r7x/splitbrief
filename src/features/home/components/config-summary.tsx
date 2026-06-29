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
import { ARROW_SEP, CHEVRON_SEP, SOFT_SEP } from '../../../components/separators.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import { CONFIG_SUMMARY_COMPACT_ROWS } from '../layout.js';

function runnerLabel(toolName: string, model: string | undefined, local = false): string {
  const provider = getProviderDisplayName(toolName);
  const modelPart = model ? `${CHEVRON_SEP}${formatModelName(model)}` : '';
  const localPart = local ? ' (local)' : '';
  return stripTerminalControls(`${provider}${modelPart}${localPart}`);
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
  const compactImplLabel = runnerLabel(implToolName, implModel);
  const mode = getWorkflowMode(config);
  const compact = isSmall || rows < CONFIG_SUMMARY_COMPACT_ROWS;

  if (compact) {
    return (
      <Box marginBottom={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Text color={theme.planner} bold>
            {plannerLabel}
          </Text>
          <Text color={theme.textDim}>{SOFT_SEP}</Text>
          <Text color={theme.implementer} bold>
            {compactImplLabel}
          </Text>
          <Text color={theme.textDim}>{SOFT_SEP}</Text>
          <Text color={theme.text} bold>
            {mode.toUpperCase()}
          </Text>
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

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color={theme.planner} bold>
            planner
          </Text>
          <Text color={theme.textDim}>{ARROW_SEP}</Text>
          <Text color={theme.implementer} bold>
            implementer
          </Text>
          <Text color={theme.textDim}>{ARROW_SEP}</Text>
          <Text color={theme.validator} bold>
            validator
          </Text>
        </Text>
        <Text color={theme.textDim}>
          expensive{SOFT_SEP}cheap{SOFT_SEP}checks drift
        </Text>
      </Box>
      <LabeledRow label="planner">
        <Box width="100%" height={1} overflow="hidden">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={theme.planner} bold wrap="truncate-end">
              {plannerLabel}
            </Text>
          </Box>
          <Text color={theme.textDim} wrap="truncate-end">
            {' '}
            /planner
          </Text>
        </Box>
      </LabeledRow>
      <LabeledRow label="implementer">
        <Box width="100%" height={1} overflow="hidden">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={theme.implementer} bold wrap="truncate-end">
              {implLabel}
            </Text>
          </Box>
          <Text color={theme.textDim} wrap="truncate-end">
            {' '}
            /implementer
          </Text>
        </Box>
      </LabeledRow>
      <LabeledRow label="mode">
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
        <LabeledRow label="skills">
          <Box width="100%" height={1} overflow="hidden">
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text color={theme.text} wrap="truncate-end">
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
