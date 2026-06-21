import { Box, Text } from 'ink';
import { formatToolModel } from '../../../core/model-display.js';
import { useTheme, type Theme } from '../../../components/theme.js';
import type { WorkflowActivityItem } from '../../../stores/workflow/activity.js';
import { activityStore } from '../../../stores/workflow/activity.js';
import { assertNever } from '../../../utils/type-guards.js';
import { fitCompactActivityDisplayLine } from '../display/activity-display-text.js';
import {
  cleanRunnerDisplayText,
  type RunnerActivityDisplay,
  runnerActivityDisplay,
  type RunnerTerminalTone,
} from '../display/runner-terminal.js';

interface ActivitySideRailProps {
  height: number;
  width: number;
}

function roleLabel(role: WorkflowActivityItem['role']): string {
  switch (role) {
    case 'planner':
      return 'plan';
    case 'implementer':
      return 'run';
    case 'review':
      return 'review';
    case 'summary':
      return 'summary';
    case 'compaction':
      return 'compact';
    case 'escalation':
      return 'escalate';
    default:
      return assertNever(role);
  }
}

function activityText(
  item: WorkflowActivityItem,
  display: RunnerActivityDisplay,
  textWidth: number,
): string {
  const tool = cleanRunnerDisplayText(formatToolModel(item.runnerName, item.model));
  const role = roleLabel(item.role);
  const value = [
    role === display.label ? null : role,
    display.value,
    display.diagnosticPreview ? `- ${display.diagnosticPreview}` : null,
    item.redacted ? '[redacted]' : null,
    tool ? `[${tool}]` : null,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');

  return fitCompactActivityDisplayLine({
    label: display.label,
    value,
    rowCells: textWidth,
    prefixCells: 0,
    ...(item.redacted && { valueFit: 'end' }),
  }).text;
}

function toneColor(tone: RunnerTerminalTone, t: Theme): string {
  switch (tone) {
    case 'info':
      return t.info;
    case 'success':
      return t.success;
    case 'warning':
      return t.warning;
    case 'error':
      return t.error;
    case 'textDim':
      return t.textDim;
    default:
      return assertNever(tone);
  }
}

export function ActivitySideRail({ height, width }: ActivitySideRailProps) {
  const t = useTheme();
  const items = activityStore.use((state) => state.items);
  const bodyHeight = Math.max(0, height - 1);
  const visibleItems = items.slice(-bodyHeight);
  const textWidth = Math.max(1, width - 5);

  return (
    <Box
      flexDirection="column"
      height={height}
      width={width}
      overflow="hidden"
      flexShrink={0}
      borderStyle="single"
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor={t.border}
      paddingLeft={1}
    >
      <Box height={1} overflow="hidden" flexShrink={0}>
        <Text bold color={t.text}>
          Activity
        </Text>
        <Text color={t.textDim}> {items.length}</Text>
      </Box>
      <Box flexDirection="column" height={bodyHeight} overflow="hidden" flexShrink={0}>
        {visibleItems.length === 0 ? (
          <Text color={t.textDim}>No runner activity</Text>
        ) : (
          visibleItems.map((item) => {
            const display = runnerActivityDisplay(item, textWidth);
            const textColor = item.redacted ? t.warning : toneColor(display.valueTone, t);
            return (
              <Box key={`${item.id}-${item.sequence}`} height={1} overflow="hidden" flexShrink={0}>
                <Text color={toneColor(display.tone, t)}>{display.marker} </Text>
                <Text color={textColor}>{activityText(item, display, textWidth)}</Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
