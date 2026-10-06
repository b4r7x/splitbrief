import { Box, Text } from 'ink';
import { SOFT_SEP } from '../../../core/separators.js';
import { borderStyleFor, glyph, type GlyphName } from '../../../lib/glyphs.js';
import { useTheme } from '../../../components/theme.js';
import type { Theme } from '../../../components/theme.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../../utils/display-text.js';
import type { WorkflowTask } from '../../../stores/workflow/tasks.js';
import { lifecycleStore, runElapsedMs } from '../../../stores/workflow/lifecycle.js';
import { selectTaskListView, taskTargetLabel, tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { configStore } from '../../../stores/project/config.js';
import { assertNever } from '../../../utils/type-guards.js';
import {
  CREW_LABEL_WIDTH,
  fitSeatIdentity,
  PLANNER_INHERITANCE,
} from '../../../core/crew/identity.js';
import { CREW_SEAT_ROLES, deriveCrewSeats, type CrewSeat } from '../../../core/crew/seats.js';
import { useCrewDisplayNames } from '../../../hooks/use-crew-display-names.js';
import { formatStageLabel } from '../../../core/phase-display.js';
import { formatElapsedClock } from '../../../utils/format-time.js';
import { getActiveRailStage } from '../../../core/rail-stages.js';
import {
  getSidebarTaskListRows,
  getSidebarTaskTitleWidth,
  getSidebarTaskWindow,
  getSidebarStatusColumnCells,
} from '../layout/rect.js';
import { useSpinnerFrame } from '../../../hooks/use-spinner-frame.js';
import { useSharedClock } from '../../../hooks/use-shared-clock.js';
import { formatLocalSharePct, localShare } from '../display/local-share.js';
import { Divider } from '../../../components/divider.js';
import { useStores } from '../../../stores/use-stores.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { deriveWorkflowDisplay } from '../display/workflow-status.js';

interface SidebarProps {
  width: number;
  height?: number | undefined;
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
  done: 'check',
  failed: 'statusFailed',
  escalated: 'statusEscalated',
  in_progress: 'statusInProgress',
  pending: 'statusPending',
  skipped: 'statusSkipped',
};

// Bar, marker, and the space after it — the cells a task row paints before its title.
const LIST_INDENT = '   ';
// 2 border cells + the 1-cell right padding + the indent a marker row shares with the title column;
// the bar sits in the cell the left padding would take.
const SIDEBAR_MARKER_ROW_OVERHEAD = 3 + LIST_INDENT.length;

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
        markerColor: t.text,
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
  const [lifecycle, controls, approval, recovery] = useStores(
    lifecycleStore,
    controlsStore,
    approvalPromptStore,
    recoveryNoticeStore,
  );
  const display = deriveWorkflowDisplay({
    status: lifecycle.status,
    cancelled: lifecycle.cancelled,
    pendingQuestion: controls.inputMode !== 'normal',
    pendingRecovery: recovery.issue !== null,
    pendingApproval: approval.status === 'pending',
  });
  const { frame } = useSpinnerFrame(display.animate);
  // The run clock the header shows, from the same ticking sample: the two surfaces cannot read
  // different seconds for one run.
  const now = useSharedClock({ active: lifecycle.status === 'running' });

  if (recovery.issue !== null) {
    return <Text color={t.warning}>{`${LIST_INDENT}Planning stopped`}</Text>;
  }
  if (display.kind === 'waiting') {
    return <Text color={t.textDim}>{`${LIST_INDENT}Waiting for your answer`}</Text>;
  }
  if (lifecycle.status !== 'running' && lifecycle.status !== 'interrupted') {
    return <Text color={t.textDim}>{`${LIST_INDENT}No tasks yet`}</Text>;
  }

  const stage = getActiveRailStage(lifecycle.phase)?.stage ?? '';
  const runMs = runElapsedMs(lifecycle, now);
  const elapsed = runMs === null ? '' : formatElapsedClock(runMs);
  return (
    <Box flexDirection="column">
      <Text color={t.textDim}>{`${LIST_INDENT}No tasks yet`}</Text>
      {lifecycle.status === 'interrupted' ? (
        <Text color={t.textDim}>{`${LIST_INDENT}Planner interrupted`}</Text>
      ) : (
        // The spinner row already says the planner is running and names the stage, so a separate
        // "Planner is working" line would float between two rows that each say more than it does.
        <Text color={t.textDim}>
          {` ${frame} ${formatStageLabel(stage)}`}
          {elapsed === '' ? '' : `${SOFT_SEP}${elapsed}`}
        </Text>
      )}
    </Box>
  );
}

function rateColor(rate: number, routed: number, t: Theme): string {
  if (routed === 0) return t.textDim;
  if (rate >= 50) return t.success;
  if (rate >= 25) return t.warning;
  return t.error;
}

function TaskRow({
  task,
  width,
  statusCells,
}: {
  task: WorkflowTask;
  width: number;
  statusCells: number;
}) {
  const t = useTheme();
  const spec = rowSpec(task.status, t);
  const titleCells = getSidebarTaskTitleWidth({ width, reservedTailCells: statusCells });
  const target = taskTargetLabel(task);
  const label = target === '' ? task.title : `${task.title} · ${target}`;
  const taskLabel = truncateTerminalDisplayText(sanitizeTerminalDisplayText(label), titleCells);
  return (
    <Box>
      <Text color={spec.labelColor} bold={spec.bold}>
        {spec.bar}
      </Text>
      <Text color={spec.markerColor} bold={spec.bold}>
        {spec.marker}{' '}
      </Text>
      <Box width={titleCells} flexShrink={0}>
        <Text color={spec.labelColor} bold={spec.bold}>
          {taskLabel}
        </Text>
      </Box>
      {spec.tail && (
        <Text color={spec.tail.color} dimColor={spec.tail.dim === true}>
          {`  ${spec.tail.text}`}
        </Text>
      )}
    </Box>
  );
}

// The running task anchors the window; once every task has settled the tail is the useful end.
function anchorIndex(tasks: readonly WorkflowTask[]): number {
  const running = tasks.findIndex((task) => task.status === 'in_progress');
  return running >= 0 ? running : Math.max(0, tasks.length - 1);
}

// The list follows the run rather than scrolling, so a bare count would be a dead end: it says work
// is out of view without saying what it is. Naming the state when the hidden slice is uniform tells
// the reader nothing actionable is hiding up there; a mixed slice falls back to the plain count.
function overflowLabel(
  hidden: readonly WorkflowTask[],
  status: WorkflowTask['status'],
  word: string,
  side: string,
): string {
  const named = hidden.length > 0 && hidden.every((task) => task.status === status);
  return `${hidden.length} ${named ? `${word} ` : ''}${side}`;
}

// One row has to carry both edges. When it cannot hold both in full the direction words go — never
// the status words, and never from one side only, because an asymmetric drop reads as the two edges
// meaning different things when the only difference is that the row ran out of cells.
function combinedOverflowLabel(above: string, below: string, width: number): string {
  const full = `${above}${SOFT_SEP}${below}`;
  const budget = width - SIDEBAR_MARKER_ROW_OVERHEAD;
  if (getTerminalCellWidth(full) <= budget) return full;
  return `${above.replace(' above', '')}${SOFT_SEP}${below.replace(' below', '')}`;
}

// The seat row spends its whole budget on the full identity; an inherited review seat says so
// instead of repeating the planner's words a row above it.
function seatIdentity(seat: CrewSeat, budget: number, displayName?: string | undefined): string {
  if (seat.id === 'review' && seat.source === 'planner') return PLANNER_INHERITANCE.mark;
  return fitSeatIdentity({ runner: seat.runner, budget, displayName });
}

function taskHasStatusTail(task: WorkflowTask): boolean {
  return task.status === 'escalated' || task.status === 'failed' || task.status === 'skipped';
}

export function Sidebar({ width, height }: SidebarProps) {
  const tooShortForBorder = height !== undefined && height < 2;
  const t = useTheme();
  const view = tasksStore.use(selectTaskListView);
  const config = configStore.use((s) => s.config);
  const displayNames = useCrewDisplayNames(config);
  const seats: readonly CrewSeat[] = config ? deriveCrewSeats({ config, displayNames }) : [];
  // The footer reports how much of the build the local seat carried, which is a routing fact. The
  // run's tokens and money are not read here at all: /usage is where they are named.
  const localCount = tokensStore.use((s) => s.localCount);
  const escalatedRoutes = tokensStore.use((s) => s.escalatedCount);
  const { rate: localRate, routedTasks } = localShare({
    localCount,
    escalatedCount: escalatedRoutes,
  });
  const tasks = view.items;
  const doneCount = tasks.filter((tk) => tk.status === 'done').length;
  const escalatedCount = tasks.filter((tk) => tk.status === 'escalated').length;
  const innerWidth = Math.max(0, width - 4);

  // The local-share row is unconditional; the done/escalated split is not.
  const footerRows = seats.length + 1 + (escalatedCount > 0 ? 1 : 0);
  // Without a height the caller is not budgeting rows, so the list never windows.
  const listRows =
    height === undefined ? tasks.length : getSidebarTaskListRows({ height, footerRows });
  const windowInput = { itemCount: tasks.length, anchorIndex: anchorIndex(tasks) };
  const fullWindow = getSidebarTaskWindow({ ...windowInput, rows: listRows });
  // The queued count shares the row the "N below" marker already claims, so it costs a row of its
  // own only when nothing is scrolled off the bottom.
  const listWindow =
    height !== undefined && view.unannounced > 0 && fullWindow.hiddenBelow === 0
      ? getSidebarTaskWindow({ ...windowInput, rows: Math.max(0, listRows - 1) })
      : fullWindow;
  const visible = tasks.slice(listWindow.start, listWindow.end);
  const hiddenAbove = tasks.slice(0, listWindow.start);
  const hiddenBelow = tasks.slice(listWindow.end);
  const aboveLabel = overflowLabel(hiddenAbove, 'done', 'done', 'above');
  const belowLabel = overflowLabel(hiddenBelow, 'pending', 'queued', 'below');
  const tail = [
    listWindow.combine ? combinedOverflowLabel(aboveLabel, belowLabel, width) : '',
    listWindow.showBelow ? belowLabel : '',
    view.unannounced > 0 ? `+${view.unannounced} more` : '',
  ].filter((part) => part !== '');
  const statusCells = getSidebarStatusColumnCells({
    hasStatusTail: tasks.some(taskHasStatusTail),
  });

  // Ink's border consumes two rows even when a smaller explicit height is supplied. At the
  // terminal's unusable 0–1 row sizes, omit the panel rather than letting its border escape the
  // body viewport; the parent will render it again as soon as a two-row panel can fit.
  if (tooShortForBorder) return null;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={borderStyleFor('single')}
      borderColor={t.border}
      borderDimColor
    >
      {/* The header shares the footer's left edge so the panel reads on one column, not four. */}
      <Box paddingX={1} flexShrink={0}>
        <Text color={t.textDim}>
          {view.total === 0 ? 'Tasks' : `Tasks ${view.passed}/${view.total}`}
        </Text>
      </Box>

      <Box
        flexDirection="column"
        paddingRight={1}
        marginTop={1}
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
      >
        {tasks.length === 0 && <SidebarWaiting />}
        {listWindow.showAbove && <Text color={t.textDim}>{`${LIST_INDENT}${aboveLabel}`}</Text>}
        {visible.map((task) => (
          <TaskRow key={task.id} task={task} width={width} statusCells={statusCells} />
        ))}
        {tail.length > 0 && <Text color={t.textDim}>{`${LIST_INDENT}${tail.join(SOFT_SEP)}`}</Text>}
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        <Box paddingX={1}>
          <Divider width={innerWidth} />
        </Box>
        <Box flexDirection="column" paddingX={1}>
          {escalatedCount > 0 && (
            <Text color={t.textDim}>
              {doneCount} done{SOFT_SEP}
              {escalatedCount} escalated
            </Text>
          )}
          {seats.map((seat) => (
            <Text key={seat.id} wrap="truncate">
              <Text color={t[CREW_SEAT_ROLES[seat.id]]} bold>
                {seat.label.padEnd(CREW_LABEL_WIDTH)}
              </Text>
              <Text color={t[CREW_SEAT_ROLES[seat.id]]}>
                {seatIdentity(seat, innerWidth - CREW_LABEL_WIDTH, displayNames?.[seat.id])}
              </Text>
            </Text>
          ))}
          <Text color={t.textDim}>
            local{' '}
            <Text color={rateColor(localRate, routedTasks, t)}>
              {formatLocalSharePct(localRate)}
            </Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
