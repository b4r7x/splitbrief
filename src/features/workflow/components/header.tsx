import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { formatRoleLabel } from '../../../core/phase-display.js';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { useStores } from '../../../stores/use-stores.js';
import { CHEVRON_SEP } from '../../../components/separators.js';
import { getChromeContentWidth, type RailForm } from '../layout/chrome-rows.js';
import { runnerShortLabel } from './runner-label.js';
import { measureRailCells, Rail } from './rail.js';

interface HeaderProps {
  startedAt: string;
  railForm?: RailForm | undefined;
}

const TIMER_WIDTH = 8;
const RUNNER_GAP = 2;

export type HeaderRunnerVariant = 'full' | 'compact' | 'none';

export interface HeaderLayout {
  contentWidth: number;
  railWidth: number;
  showElapsed: boolean;
  runnerVariant: HeaderRunnerVariant;
}

function formatElapsedClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${minutes}:${seconds}`;
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

export function getHeaderLayout(input: {
  cols: number;
  isSmall: boolean;
  railCells: number;
  runnerFullCells?: number | undefined;
  runnerCompactCells?: number | undefined;
}): HeaderLayout {
  const { cols, isSmall, railCells, runnerFullCells = 0, runnerCompactCells = 0 } = input;
  const contentWidth = getChromeContentWidth(cols);
  const gap = 1;
  const minRail = Math.min(contentWidth, Math.max(0, railCells));
  const elapsedTail = TIMER_WIDTH;
  const tailRoom = contentWidth - minRail - gap;
  const showElapsed = tailRoom >= elapsedTail;
  const elapsedWidth = showElapsed ? elapsedTail : 0;
  const runnerRoom = contentWidth - minRail - gap - elapsedWidth - RUNNER_GAP;
  let runnerVariant: HeaderRunnerVariant = 'none';
  if (!isSmall && runnerFullCells > 0 && runnerRoom >= runnerFullCells) {
    runnerVariant = 'full';
  } else if (runnerCompactCells > 0 && runnerRoom >= runnerCompactCells) {
    runnerVariant = 'compact';
  }
  const runnerWidth =
    runnerVariant === 'full'
      ? runnerFullCells
      : runnerVariant === 'compact'
        ? runnerCompactCells
        : 0;
  const tailWidth = elapsedWidth + (runnerWidth > 0 ? runnerWidth + RUNNER_GAP : 0);
  const railWidth = tailWidth > 0 ? Math.max(0, contentWidth - tailWidth - gap) : contentWidth;
  return { contentWidth, railWidth, showElapsed, runnerVariant };
}

export function Header({ startedAt, railForm }: HeaderProps) {
  const [{ cols, isSmall }, lifecycle, tasks, tokens, eventsState] = useStores(
    terminalSizeStore,
    lifecycleStore,
    tasksStore,
    tokensStore,
    eventsStore,
  );
  const { startedAt: lifecycleStartedAt, endedAt, durationMs, phase, cancelled } = lifecycle;
  const t = useTheme();
  const config = configStore.use((s) => s.config);
  const railCells = measureRailCells({
    phase,
    cancelled,
    form: railForm ?? 'B',
    cols,
    tasks,
    localCount: tokens.localCount,
    events: eventsState.events,
  });

  const plannerLabel = config ? runnerShortLabel(config.planner) : '';
  const implLabel = config ? runnerShortLabel(config.implementer) : '';
  const hasRunner = plannerLabel !== '' && implLabel !== '';
  const runnerFull = hasRunner
    ? `${formatRoleLabel('planner')} ${plannerLabel}${CHEVRON_SEP}${formatRoleLabel('implementer')} ${implLabel}`
    : '';
  const runnerCompact = hasRunner ? `${plannerLabel}${CHEVRON_SEP}${implLabel}` : '';
  const layout = getHeaderLayout({
    cols,
    isSmall,
    railCells,
    runnerFullCells: getTerminalCellWidth(runnerFull),
    runnerCompactCells: getTerminalCellWidth(runnerCompact),
  });

  return (
    <Box width="100%" height={1} overflow="hidden">
      <Box width={layout.railWidth} overflow="hidden">
        <Rail form={railForm} />
      </Box>
      <Box flexGrow={1} />
      {layout.runnerVariant !== 'none' && (
        <Box flexShrink={0} marginRight={layout.showElapsed ? 2 : 0}>
          {layout.runnerVariant === 'full' ? (
            <Text>
              <Text color={t.planner} bold>
                {`${formatRoleLabel('planner')} `}
              </Text>
              <Text color={t.planner}>{plannerLabel}</Text>
              <Text color={t.textDim}>{CHEVRON_SEP}</Text>
              <Text color={t.implementer} bold>
                {`${formatRoleLabel('implementer')} `}
              </Text>
              <Text color={t.implementer}>{implLabel}</Text>
            </Text>
          ) : (
            <Text>
              <Text color={t.planner} bold>
                {plannerLabel}
              </Text>
              <Text color={t.textDim}>{CHEVRON_SEP}</Text>
              <Text color={t.implementer} bold>
                {implLabel}
              </Text>
            </Text>
          )}
        </Box>
      )}
      {layout.showElapsed && (
        <Box justifyContent="flex-end">
          <ElapsedClock
            mountedAt={startedAt}
            lifecycleStartedAt={lifecycleStartedAt}
            endedAt={endedAt}
            durationMs={durationMs}
          />
        </Box>
      )}
    </Box>
  );
}
