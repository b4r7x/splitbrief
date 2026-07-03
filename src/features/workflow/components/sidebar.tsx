import { Box, Text } from 'ink';
import { ARROW_SEP, SOFT_SEP } from '../../../components/separators.js';
import { borderStyleFor, glyph, type GlyphName } from '../../../lib/glyphs.js';
import { useTheme } from '../../../components/theme.js';
import type { Theme } from '../../../components/theme.js';
import {
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../../utils/display-text.js';
import type { WorkflowTask } from '../../../stores/workflow/tasks.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { configStore } from '../../../stores/project/config.js';
import { assertNever } from '../../../utils/type-guards.js';
import { formatStageElapsed } from '../display/live-activity.js';
import { getActiveRailStage } from '../layout/chrome-rows.js';
import { useAdvisory } from '../hooks/use-advisory.js';
import { useCostStats } from '../hooks/use-cost-stats.js';
import { useSpinnerFrame } from '../hooks/use-spinner-frame.js';
import { formatCostDisplay } from '../cost-text.js';
import { Divider } from './divider.js';
import { runnerShortLabel } from './runner-label.js';

interface SidebarProps {
  width: number;
}

interface RowSpec {
  bar: string;
  marker: string;
  markerColor: string;
  labelColor: string;
  bold: boolean;
  tail?: { text: string; color: string; dim?: boolean };
}

const TASK_STATUS_GLYPH_NAME: Record<WorkflowTask['status'], GlyphName> = {
  done: 'statusDone',
  failed: 'statusFailed',
  escalated: 'statusEscalated',
  in_progress: 'statusInProgress',
  pending: 'statusPending',
  skipped: 'statusSkipped',
};

function statusGlyph(status: WorkflowTask['status']): string {
  return glyph(TASK_STATUS_GLYPH_NAME[status]);
}

function rowSpec(status: WorkflowTask['status'], t: Theme): RowSpec {
  switch (status) {
    case 'done':
      return {
        bar: ' ',
        marker: statusGlyph('done'),
        markerColor: t.success,
        labelColor: t.textDim,
        bold: false,
      };
    case 'in_progress':
      return {
        bar: glyph('liveBar'),
        marker: statusGlyph('in_progress'),
        markerColor: t.implementer,
        labelColor: t.text,
        bold: true,
      };
    case 'pending':
      return {
        bar: ' ',
        marker: statusGlyph('pending'),
        markerColor: t.textDim,
        labelColor: t.textDim,
        bold: false,
      };
    case 'escalated':
      return {
        bar: ' ',
        marker: statusGlyph('escalated'),
        markerColor: t.warning,
        labelColor: t.text,
        bold: false,
        tail: { text: 'escalated', color: t.textDim },
      };
    case 'failed':
      return {
        bar: ' ',
        marker: statusGlyph('failed'),
        markerColor: t.error,
        labelColor: t.text,
        bold: false,
        tail: { text: 'failed', color: t.error, dim: true },
      };
    case 'skipped':
      return {
        bar: ' ',
        marker: statusGlyph('skipped'),
        markerColor: t.textDim,
        labelColor: t.textDim,
        bold: false,
        tail: { text: 'skipped', color: t.textDim },
      };
    default:
      return assertNever(status);
  }
}

function SidebarWaiting() {
  const t = useTheme();
  const phase = lifecycleStore.use((s) => s.phase);
  const running = lifecycleStore.use((s) => s.status === 'running');
  const startedAt = lifecycleStore.use((s) => s.startedAt);
  const { frame } = useSpinnerFrame(running);

  if (!running) return <Text color={t.textDim}>no tasks yet</Text>;

  const stage = getActiveRailStage(phase)?.stage ?? '';
  const elapsed = startedAt !== null ? formatStageElapsed(Date.now() - startedAt) : '';
  return (
    <Box flexDirection="column">
      <Text color={t.textDim}>no tasks yet</Text>
      <Text color={t.textDim}>planner is working</Text>
      <Text color={t.textDim}>
        {`${frame} ${stage}`}
        {elapsed === '' ? '' : `${SOFT_SEP}${elapsed}`}
      </Text>
    </Box>
  );
}

function rateColor(rate: number, routed: number, t: Theme): string {
  if (routed === 0) return t.textDim;
  if (rate >= 50) return t.success;
  if (rate >= 25) return t.warning;
  return t.error;
}

export function Sidebar({ width }: SidebarProps) {
  const t = useTheme();
  const tasks = tasksStore.use((s) => s.tasks);
  const mode = configStore.use((s) => s.config?.workflow?.mode);
  const planner = configStore.use((s) => s.config?.planner);
  const implementer = configStore.use((s) => s.config?.implementer);
  const plannerLabel = planner ? runnerShortLabel(planner) : '';
  const implLabel = implementer ? runnerShortLabel(implementer) : '';
  const advisory = useAdvisory();
  const cost = useCostStats();
  const localCount = tasks.filter((tk) => tk.status === 'done').length;
  const escalatedCount = tasks.filter((tk) => tk.status === 'escalated').length;
  const completedCount = localCount + escalatedCount;
  const labelWidth = Math.max(10, width - 6);
  const innerWidth = Math.max(0, width - 5);

  const costFmt = formatCostDisplay(cost.localRate, cost.costBreakdown, cost.pricingState);

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle={borderStyleFor('single')}
      borderColor={t.border}
      borderDimColor
    >
      <Box paddingX={1} flexShrink={0}>
        <Text color={t.textDim}>{` tasks  ${completedCount}/${tasks.length}`}</Text>
      </Box>

      <Box
        flexDirection="column"
        paddingX={1}
        marginTop={1}
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
      >
        {tasks.length === 0 && <SidebarWaiting />}
        {tasks.map((task) => {
          const spec = rowSpec(task.status, t);
          const reserved = spec.tail ? spec.tail.text.length + 2 : 0;
          const title = truncateTerminalDisplayText(
            sanitizeTerminalDisplayText(task.title),
            Math.max(labelWidth - 2 - reserved, 10),
          );
          return (
            <Box key={task.id}>
              <Text color={t.accent} bold>
                {spec.bar}
              </Text>
              <Text color={spec.markerColor} bold={spec.bold}>
                {spec.marker}{' '}
              </Text>
              <Text color={spec.labelColor} bold={spec.bold}>
                {title}
              </Text>
              {spec.tail && (
                <Text
                  color={spec.tail.color}
                  dimColor={spec.tail.dim === true}
                >{`  ${spec.tail.text}`}</Text>
              )}
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        <Box paddingLeft={2} paddingRight={1}>
          <Divider width={innerWidth} />
        </Box>
        <Box flexDirection="column" paddingLeft={2} paddingRight={1}>
          {mode && (
            <Text color={t.textDim}>
              {mode}
              {advisory && advisory.kind !== 'none' && (
                <Text>
                  {SOFT_SEP}risk <Text color={t.warning}>{advisory.risk}</Text>
                </Text>
              )}
            </Text>
          )}
          {escalatedCount > 0 && (
            <Text color={t.textDim}>
              {localCount} local{SOFT_SEP}
              {escalatedCount} escalated
            </Text>
          )}
          <Text wrap="truncate">
            <Text color={t.planner} bold>
              Planner
            </Text>
            {plannerLabel !== '' && <Text color={t.planner}>{` ${plannerLabel}`}</Text>}
            <Text color={t.textDim}>{ARROW_SEP}</Text>
            <Text color={t.implementer} bold>
              Implementer
            </Text>
            {implLabel !== '' && <Text color={t.implementer}>{` ${implLabel}`}</Text>}
          </Text>
          <Text color={t.textDim}>
            local{' '}
            <Text color={rateColor(cost.localRate, cost.routedTasks, t)}>
              {costFmt.localRatePct}
            </Text>
            {costFmt.hasPricedUsage && (
              <Text>
                {'  ·  '}
                {costFmt.spentText}
              </Text>
            )}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
