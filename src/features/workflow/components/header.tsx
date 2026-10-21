import { ThemeText as Text } from '../../../components/theme.js';
import { TextSpans } from '../../../components/text-spans.js';
import type { ReactNode } from 'react';
import { Box } from 'ink';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { useStores } from '../../../stores/use-stores.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { formatCollapsedSeatSpans, seatLineText } from '../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { useCrewDisplayNames } from '../../../hooks/use-crew-display-names.js';
import type { CrewSeatId, SeatLineSpan } from '../../../core/crew/identity.js';
import { haltedIssue } from '../../../core/sessions/run-status.js';
import { formatResetNote } from '../../../core/recovery/reset-clock.js';
import type { RailStageState } from '../../../core/rail-stages.js';
import { getChromeContentWidth, type RailForm } from '../layout/chrome-rows.js';
import { Rail } from './rail.js';
import { useRailCells } from '../hooks/use-rail-cells.js';

interface HeaderProps {
  railForm?: RailForm | undefined;
  buildBlockShown?: boolean | undefined;
  /** A run at rest names the stages its own record earned, and the crew that actually ran it. */
  stages?: readonly RailStageState[] | undefined;
  seatLine?: readonly SeatLineSpan[] | undefined;
}

const SEAT_GAP = 2;

export interface HeaderLayout {
  contentWidth: number;
  railWidth: number;
  /** The cells left for the seat line once the rail is paid for. */
  seatRoom: number;
  showSeats: boolean;
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
  const minRail = Math.min(contentWidth, Math.max(0, railCells));
  const seatRoom = contentWidth - minRail - SEAT_GAP;
  const showSeats = seatCells > 0 && seatRoom >= seatCells;
  const railWidth = showSeats ? contentWidth - seatCells - SEAT_GAP : contentWidth;
  return { contentWidth, railWidth, seatRoom, showSeats };
}

export function Header({
  railForm,
  buildBlockShown = false,
  stages,
  seatLine: givenSeatLine,
}: HeaderProps) {
  const [{ cols }, recoveryNotice] = useStores(terminalSizeStore, recoveryNoticeStore);
  const config = configStore.use((s) => s.config);
  const savedHalt = routerStore.use((state) =>
    state.screen === 'workflow' && state.execution.kind === 'at-rest'
      ? haltedIssue(state.run.status)
      : null,
  );
  const displayNames = useCrewDisplayNames(config);
  const railCells = useRailCells({ form: railForm, buildBlockShown, stages });

  // The room does not depend on the line, so the first pass measures it, the
  // line is cut to it, and the second pass lays the bar out around what fits.
  const { seatRoom } = getHeaderLayout({ cols, railCells });
  const seatNotes = seatResetNotes(recoveryNotice.seat, recoveryNotice.resetAt);
  const liveSeatLine = config
    ? formatCollapsedSeatSpans({
        planner: config.planner,
        build: resolveImplementerProfiles(config).defaultProfile.config,
        reviewer: configuredReviewerRunner(config),
        budget: seatRoom,
        haltedSeat: recoveryNotice.seat ?? savedHalt?.seat,
        displayNames,
        ...(seatNotes !== undefined && { notes: seatNotes }),
      })
    : [];
  const seatLine = givenSeatLine ?? liveSeatLine;
  return (
    <HeaderRow
      cols={cols}
      railCells={railCells}
      seatLine={seatLine}
      rail={
        <Rail
          form={railForm}
          buildBlockShown={buildBlockShown}
          {...(stages !== undefined && { stages })}
        />
      }
    />
  );
}

/**
 * The header bar itself: rail on the left, the seat line pinned right, both paid for out of one
 * budget. It reads no store: the caller passes the rail and the seat line.
 */
function HeaderRow({
  rail,
  railCells,
  seatLine,
  cols,
}: {
  rail: ReactNode;
  railCells: number;
  seatLine: readonly SeatLineSpan[];
  cols: number;
}) {
  const layout = getHeaderLayout({
    cols,
    railCells,
    seatCells: getTerminalCellWidth(seatLineText(seatLine)),
  });
  return (
    <Box width="100%" height={1} overflow="hidden">
      <Box width={layout.railWidth} overflow="hidden">
        {rail}
      </Box>
      <Box flexGrow={1} />
      {layout.showSeats && (
        <Box flexShrink={0}>
          <Text>
            <TextSpans
              parts={seatLine.map((span) => ({
                text: span.text,
                tone: span.seat === undefined ? 'textDim' : CREW_SEAT_ROLES[span.seat],
              }))}
            />
          </Text>
        </Box>
      )}
    </Box>
  );
}
