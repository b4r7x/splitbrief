import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { formatElapsedClock } from '../../../utils/format-time.js';
import { useSharedClock } from '../../../hooks/use-shared-clock.js';
import { useRunMode } from '../hooks/use-run-mode.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { configStore } from '../../../stores/project/config.js';
import { useStores } from '../../../stores/use-stores.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { formatCollapsedSeatLine } from '../../../core/crew/identity.js';
import { useCrewDisplayNames } from '../../../hooks/use-crew-display-names.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import { formatResetNote } from '../../../core/recovery/reset-clock.js';
import type { RailStageState } from '../../../core/rail-stages.js';
import { getChromeContentWidth, type RailForm } from '../layout/chrome-rows.js';
import { measureRailCells, Rail } from './rail.js';

interface HeaderProps {
  startedAt: string;
  railForm?: RailForm | undefined;
  /** A run at rest names the stages its own record earned, and the crew that actually ran it. */
  stages?: readonly RailStageState[] | undefined;
  seatLine?: string | undefined;
}

const TIMER_WIDTH = 8;
const SEAT_GAP = 2;

export interface HeaderLayout {
  contentWidth: number;
  railWidth: number;
  /** The cells left for the seat line once the rail and the clock are paid for. */
  seatRoom: number;
  showElapsed: boolean;
  showSeats: boolean;
}

function formatElapsed(input: {
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  now: number;
}): string {
  const { startedAt, endedAt, durationMs, now } = input;
  if (durationMs != null) return formatElapsedClock(durationMs);
  const end = endedAt ?? now;
  return formatElapsedClock(end - startedAt);
}

/**
 * The run clock: wall-clock time since the run started. It keeps counting while a gate, a question,
 * an approval or a recovery choice waits on the user, because the run is still running; only the
 * byline's clock leaves those waits out. It stops when the run stops: a park, a run at rest, the
 * end. The seconds come from the shared clock the sidebar reads, so the two surfaces state the
 * same run clock.
 */
function ElapsedClock({
  mountedAt,
  lifecycleStartedAt,
  endedAt,
  durationMs,
  running,
}: {
  mountedAt: string;
  lifecycleStartedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  running: boolean;
}) {
  const t = useTheme();
  const mountedAtMs = Date.parse(mountedAt);
  const startedAt = lifecycleStartedAt ?? (Number.isFinite(mountedAtMs) ? mountedAtMs : Date.now());
  const ticking = endedAt == null && durationMs == null && running;
  const now = useSharedClock({ active: ticking });
  return <Text color={t.textDim}>{formatElapsed({ startedAt, endedAt, durationMs, now })}</Text>;
}

/** An open halt annotates its own seat and only while it names both the seat and a reset. */
function seatResetNotes(
  seat: CrewSeatId | null,
  resetAt: number | null,
): Partial<Record<CrewSeatId, string>> | undefined {
  if (seat === null || resetAt === null) return undefined;
  const notes: Partial<Record<CrewSeatId, string>> = {};
  notes[seat] = formatResetNote(resetAt);
  return notes;
}

export function getHeaderLayout(input: {
  cols: number;
  railCells: number;
  seatCells?: number | undefined;
}): HeaderLayout {
  const { cols, railCells, seatCells = 0 } = input;
  const contentWidth = getChromeContentWidth(cols);
  const gap = 1;
  const minRail = Math.min(contentWidth, Math.max(0, railCells));
  const showElapsed = contentWidth - minRail - gap >= TIMER_WIDTH;
  const elapsedWidth = showElapsed ? TIMER_WIDTH : 0;
  const seatRoom = contentWidth - minRail - gap - elapsedWidth - SEAT_GAP;
  const showSeats = seatCells > 0 && seatRoom >= seatCells;
  const tailWidth = elapsedWidth + (showSeats ? seatCells + SEAT_GAP : 0);
  const railWidth = tailWidth > 0 ? Math.max(0, contentWidth - tailWidth - gap) : contentWidth;
  return { contentWidth, railWidth, seatRoom, showElapsed, showSeats };
}

export function Header({ startedAt, railForm, stages, seatLine: givenSeatLine }: HeaderProps) {
  const [{ cols }, lifecycle, tasks, tokens, eventsState, recoveryNotice] = useStores(
    terminalSizeStore,
    lifecycleStore,
    tasksStore,
    tokensStore,
    eventsStore,
    recoveryNoticeStore,
  );
  const { startedAt: lifecycleStartedAt, endedAt, durationMs, phase, cancelled } = lifecycle;
  const config = configStore.use((s) => s.config);
  const displayNames = useCrewDisplayNames(config);
  // The rail draws the run's own mode, not the config's: quick has no Spec step, so an old quick
  // `researching` phase maps onto Plan and Spec never earns a completed mark. The shared
  // derivation keeps the rail on the mode the engine resolved when `/mode` writes the next run's.
  const mode = useRunMode() ?? DEFAULT_WORKFLOW_MODE;
  const railCells = measureRailCells({
    phase,
    cancelled,
    form: railForm ?? 'B',
    cols,
    mode,
    tasks,
    localCount: tokens.localCount,
    events: eventsState.events,
    ...(stages !== undefined && { stages }),
  });

  // The room does not depend on the line, so the first pass measures it, the
  // line is cut to it, and the second pass lays the bar out around what fits.
  const { seatRoom } = getHeaderLayout({ cols, railCells });
  const seatNotes = seatResetNotes(recoveryNotice.seat, recoveryNotice.resetAt);
  const liveSeatLine = config
    ? formatCollapsedSeatLine({
        planner: config.planner,
        build: resolveImplementerProfiles(config).defaultProfile.config,
        reviewer: configuredReviewerRunner(config),
        budget: seatRoom,
        displayNames,
        ...(seatNotes !== undefined && { notes: seatNotes }),
      })
    : '';
  const seatLine = givenSeatLine ?? liveSeatLine;
  return (
    <HeaderRow
      cols={cols}
      railCells={railCells}
      seatLine={seatLine}
      rail={<Rail form={railForm} mode={mode} {...(stages !== undefined && { stages })} />}
      clock={
        <ElapsedClock
          mountedAt={startedAt}
          lifecycleStartedAt={lifecycleStartedAt}
          endedAt={endedAt}
          durationMs={durationMs}
          running={lifecycle.status === 'running'}
        />
      }
    />
  );
}

/**
 * The header bar itself: rail on the left, the seat line and the clock pinned right, each paid for
 * out of one budget. It reads no store, so the summary screen can paint the same bar from a
 * finished run's record.
 */
export function HeaderRow({
  rail,
  railCells,
  seatLine,
  clock,
  cols,
}: {
  rail: ReactNode;
  railCells: number;
  seatLine: string;
  clock: ReactNode;
  cols: number;
}) {
  const t = useTheme();
  const layout = getHeaderLayout({ cols, railCells, seatCells: getTerminalCellWidth(seatLine) });
  return (
    <Box width="100%" height={1} overflow="hidden">
      <Box width={layout.railWidth} overflow="hidden">
        {rail}
      </Box>
      <Box flexGrow={1} />
      {layout.showSeats && (
        <Box flexShrink={0} marginRight={layout.showElapsed ? SEAT_GAP : 0}>
          <Text color={t.textDim}>{seatLine}</Text>
        </Box>
      )}
      {layout.showElapsed && <Box justifyContent="flex-end">{clock}</Box>}
    </Box>
  );
}
