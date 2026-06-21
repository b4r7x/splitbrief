import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../../../components/theme.js';
import type { WorkflowActivityItem } from '../../../stores/workflow/activity.js';
import { activityStore } from '../../../stores/workflow/activity.js';
import { fitCompactActivityDisplayLine } from '../display/activity-display-text.js';
import {
  runnerActivityLedgerItem,
  runnerActivityRoleLabel,
  runnerActivitySeverityRank,
  runnerActivityToolLabel,
  type RunnerActivityLedgerItem,
  type RunnerActivityLedgerTone,
} from '../display/runner-activity-display.js';

interface ActivitySideRailProps {
  height: number;
  width: number;
}

function toneColor(tone: RunnerActivityLedgerTone, t: Theme): string {
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
  }
}

interface RailDisplayItem {
  item: WorkflowActivityItem;
  display: RunnerActivityLedgerItem;
}

export function ActivitySideRail({ height, width }: ActivitySideRailProps) {
  const t = useTheme();
  const items = activityStore.use((state) => state.items);
  const bodyHeight = Math.max(0, height - 1);
  const textWidth = Math.max(1, width - 3);
  const currentItems = currentCallItems(items);
  const displayItems = currentItems.map((item) => ({
    item,
    display: runnerActivityLedgerItem(item),
  }));
  const current = currentItems.at(-1);
  const summary = current ? currentCallSummary(current) : null;
  const groups = groupSummary(displayItems);
  const pinned = highestSeverityPinnedItem(displayItems);
  const fixedRows = (summary ? 1 : 0) + (groups ? 1 : 0) + (pinned ? 1 : 0);
  const tailLimit = Math.max(0, bodyHeight - fixedRows);
  const recent = displayItems.filter((displayItem) => displayItem !== pinned).slice(-tailLimit);

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
        <Text color={t.textDim}> {currentItems.length}</Text>
      </Box>
      <Box flexDirection="column" height={bodyHeight} overflow="hidden" flexShrink={0}>
        {items.length === 0 ? (
          <Text color={t.textDim}>No runner activity</Text>
        ) : (
          <>
            {summary && <RailText key="summary" text={summary} color={t.text} />}
            {groups && <RailText key="groups" text={groups} color={t.textDim} />}
            {pinned && (
              <RailActivityRow
                key={`pinned-${pinned.item.id}-${pinned.item.sequence}`}
                displayItem={pinned}
                textWidth={textWidth}
                theme={t}
              />
            )}
            {recent.map((displayItem) => (
              <RailActivityRow
                key={`${displayItem.item.id}-${displayItem.item.sequence}`}
                displayItem={displayItem}
                textWidth={textWidth}
                theme={t}
              />
            ))}
          </>
        )}
      </Box>
    </Box>
  );
}

function RailText({ text, color }: { text: string; color: string }) {
  return (
    <Box height={1} overflow="hidden" flexShrink={0}>
      <Text color={color} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  );
}

function RailActivityRow({
  displayItem,
  textWidth,
  theme,
}: {
  displayItem: RailDisplayItem;
  textWidth: number;
  theme: Theme;
}) {
  const text = activityText(displayItem.display, textWidth);
  const color = displayItem.item.redacted
    ? theme.warning
    : toneColor(displayItem.display.valueTone, theme);
  return <RailText text={text} color={color} />;
}

function currentCallItems(items: readonly WorkflowActivityItem[]): WorkflowActivityItem[] {
  const latest = items.at(-1);
  if (latest === undefined) return [];
  return items.filter((item) => item.callId === latest.callId);
}

function currentCallSummary(item: WorkflowActivityItem): string {
  const tool = runnerActivityToolLabel(item);
  return [runnerActivityRoleLabel(item.role), item.phase, tool ? `[${tool}]` : null]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');
}

function groupSummary(displayItems: readonly RailDisplayItem[]): string | null {
  const groups = new Map<string, number>();
  for (const { display } of displayItems) {
    groups.set(display.groupLabel, (groups.get(display.groupLabel) ?? 0) + 1);
  }
  if (groups.size === 0) return null;
  return Array.from(groups, ([label, count]) => `${label} ${count}`).join('  ');
}

function highestSeverityPinnedItem(
  displayItems: readonly RailDisplayItem[],
): RailDisplayItem | null {
  let best: RailDisplayItem | null = null;
  for (const displayItem of displayItems) {
    if (!displayItem.display.pinned) continue;
    if (
      best === null ||
      runnerActivitySeverityRank(displayItem.display.severity) >=
        runnerActivitySeverityRank(best.display.severity)
    ) {
      best = displayItem;
    }
  }
  return best;
}

function activityText(display: RunnerActivityLedgerItem, textWidth: number): string {
  const rawMarker = display.rawMarker ? `  ${display.rawMarker}` : '';
  const line = fitCompactActivityDisplayLine({
    label: display.label.padEnd(4),
    value: display.value,
    rowCells: textWidth - rawMarker.length,
    prefixCells: 0,
    valueFit: display.fitMode,
  });
  return `${line.text}${rawMarker}`;
}
