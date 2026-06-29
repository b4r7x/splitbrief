import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../utils/display-text.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { configStore } from '../../../stores/project/config.js';
import { useStores } from '../../../stores/use-stores.js';
import { CHEVRON_SEP } from '../../../components/separators.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { runnerShortLabel } from './runner-label.js';

interface HeaderProps {
  startedAt: string;
}

const TIMER_WIDTH = 10;
const STATUS_JOINER = ' · ';
const RUNNER_GAP = 2;

export type HeaderRunnerVariant = 'full' | 'compact' | 'none';

export interface HeaderLayout {
  contentWidth: number;
  featureWidth: number;
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
  const mountedAtMs = Date.parse(mountedAt);
  const startedAt = lifecycleStartedAt ?? (Number.isFinite(mountedAtMs) ? mountedAtMs : Date.now());
  const [elapsed, setElapsed] = useState(() => formatElapsed(startedAt, endedAt, durationMs));

  useEffect(() => {
    setElapsed(formatElapsed(startedAt, endedAt, durationMs));
    if (endedAt != null || durationMs != null) return;
    const id = setInterval(() => setElapsed(formatElapsed(startedAt, null, null)), 1000);
    return () => clearInterval(id);
  }, [startedAt, endedAt, durationMs]);

  return <Text color={t.textDim}>{elapsed}</Text>;
}

export function getHeaderLayout(input: {
  cols: number;
  isSmall: boolean;
  featureCells: number;
  runnerFullCells?: number | undefined;
  runnerCompactCells?: number | undefined;
}): HeaderLayout {
  const { cols, isSmall, featureCells, runnerFullCells = 0, runnerCompactCells = 0 } = input;
  const contentWidth = getChromeContentWidth(cols);
  const featureCap = isSmall ? 44 : 72;
  const gap = 1;
  const minFeature = Math.min(featureCap, Math.max(0, featureCells));
  const elapsedTail = STATUS_JOINER.length + TIMER_WIDTH;
  const tailRoom = contentWidth - minFeature - gap;
  const showElapsed = tailRoom >= elapsedTail;
  const elapsedWidth = showElapsed ? elapsedTail : 0;
  const runnerRoom = contentWidth - minFeature - gap - elapsedWidth - RUNNER_GAP;
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
  const featureWidth =
    tailWidth > 0
      ? Math.min(featureCap, Math.max(0, contentWidth - tailWidth - gap))
      : Math.min(featureCap, contentWidth);
  return { contentWidth, featureWidth, showElapsed, runnerVariant };
}

export function Header({ startedAt }: HeaderProps) {
  const [{ cols, isSmall }, lifecycle] = useStores(terminalSizeStore, lifecycleStore);
  const { startedAt: lifecycleStartedAt, endedAt, durationMs } = lifecycle;
  const t = useTheme();
  const config = configStore.use((s) => s.config);
  const feature = routerStore.use((s) =>
    s.screen === 'workflow' ? sanitizeTerminalDisplayText(s.feature) : '',
  );
  const worktreeName = routerStore.use((s) =>
    s.screen === 'workflow' ? s.worktreeName : undefined,
  );

  const plannerLabel = config ? runnerShortLabel(config.planner) : '';
  const implLabel = config ? runnerShortLabel(config.implementer) : '';
  const hasRunner = plannerLabel !== '' && implLabel !== '';
  const runnerFull = hasRunner ? `planner ${plannerLabel}${CHEVRON_SEP}impl ${implLabel}` : '';
  const runnerCompact = hasRunner ? `${plannerLabel}${CHEVRON_SEP}${implLabel}` : '';
  const layout = getHeaderLayout({
    cols,
    isSmall,
    featureCells: getTerminalCellWidth(feature),
    runnerFullCells: getTerminalCellWidth(runnerFull),
    runnerCompactCells: getTerminalCellWidth(runnerCompact),
  });
  const featureText = truncateTerminalDisplayText(feature, layout.featureWidth);
  const worktreeNameCap = Math.max(
    0,
    layout.featureWidth - getTerminalCellWidth(featureText) - STATUS_JOINER.length,
  );
  const worktreeText =
    worktreeName && worktreeNameCap > 0
      ? `${STATUS_JOINER}${truncateTerminalDisplayTextMiddle(worktreeName, worktreeNameCap)}`
      : '';

  return (
    <Box width="100%" height={1} overflow="hidden" paddingX={1}>
      <Box width={layout.featureWidth} overflow="hidden">
        {layout.featureWidth > 0 && <Text color={t.text}>{featureText}</Text>}
        {worktreeText !== '' && <Text color={t.textDim}>{worktreeText}</Text>}
      </Box>
      <Box flexGrow={1} />
      {layout.runnerVariant !== 'none' && (
        <Box flexShrink={0} marginRight={layout.showElapsed ? 2 : 0}>
          {layout.runnerVariant === 'full' ? (
            <Text>
              <Text color={t.planner} bold>
                {'planner '}
              </Text>
              <Text color={t.planner}>{plannerLabel}</Text>
              <Text color={t.textDim}>{CHEVRON_SEP}</Text>
              <Text color={t.implementer} bold>
                {'impl '}
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
