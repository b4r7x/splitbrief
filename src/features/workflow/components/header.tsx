import { useState, useEffect, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { formatElapsedClock } from '../../../utils/format-time.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { configStore } from '../../../stores/project/config.js';
import { useStores } from '../../../stores/use-stores.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
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

function formatElapsed(
  startedAt: number,
  endedAt: number | null,
  durationMs: number | null,
): string {
  if (durationMs != null) return formatElapsedClock(durationMs);
  const end = endedAt ?? Date.now();
  return formatElapsedClock(end - startedAt);
}

function ElapsedClock({
  mountedAt,
  lifecycleStartedAt,
  endedAt,
  durationMs,
}: {
  mountedAt: string;
  lifecycleStartedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
}) {
  const t = useTheme();
  const status = lifecycleStore.use((s) => s.status);
  const mountedAtMs = Date.parse(mountedAt);
  const startedAt = lifecycleStartedAt ?? (Number.isFinite(mountedAtMs) ? mountedAtMs : Date.now());
  const [elapsed, setElapsed] = useState(() => formatElapsed(startedAt, endedAt, durationMs));

  useEffect(() => {
    setElapsed(formatElapsed(startedAt, endedAt, durationMs));
    if (endedAt != null || durationMs != null || status !== 'running') return;
    const id = setInterval(() => setElapsed(formatElapsed(startedAt, null, null)), 1000);
    return () => clearInterval(id);
  }, [startedAt, endedAt, durationMs, status]);

  return <Text color={t.textDim}>{elapsed}</Text>;
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
  const railCells = measureRailCells({
    phase,
    cancelled,
    form: railForm ?? 'B',
    cols,
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
      rail={<Rail form={railForm} {...(stages !== undefined && { stages })} />}
      clock={
        <ElapsedClock
          mountedAt={startedAt}
          lifecycleStartedAt={lifecycleStartedAt}
          endedAt={endedAt}
          durationMs={durationMs}
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
