import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { PipelineBar, PIPELINE_BAR_WIDTH } from './pipeline-bar.js';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { truncateWithEllipsis } from '../../../utils/truncate.js';
import { formatTimeHHMMSS } from '../../../utils/format-time.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useStores } from '../../../stores/use-stores.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';

interface HeaderProps {
  startedAt: string;
}

const TIMER_WIDTH = 10;

export interface HeaderLayout {
  contentWidth: number;
  featureWidth: number;
  rightWidth: number;
  showPipeline: boolean;
  pipelineGap: number;
}

function formatElapsed(
  startedAt: number,
  endedAt: number | null,
  durationMs: number | null,
): string {
  if (durationMs != null) return formatTimeHHMMSS(durationMs);
  const end = endedAt ?? Date.now();
  return formatTimeHHMMSS(end - startedAt);
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

export function getHeaderLayout(cols: number, isSmall: boolean): HeaderLayout {
  const contentWidth = getChromeContentWidth(cols);
  const pipelineGap = isSmall ? 2 : 3;
  const titleGap = 1;
  const minFeatureWidth = isSmall ? 8 : 16;
  const featureCap = isSmall ? 44 : 72;
  const showPipeline =
    contentWidth >= minFeatureWidth + titleGap + PIPELINE_BAR_WIDTH + pipelineGap + TIMER_WIDTH;
  const rightWidth = showPipeline ? PIPELINE_BAR_WIDTH + pipelineGap + TIMER_WIDTH : TIMER_WIDTH;
  const availableFeatureWidth = Math.max(
    0,
    contentWidth - rightWidth - (showPipeline ? titleGap : 1),
  );
  const featureWidth = Math.min(featureCap, availableFeatureWidth);

  return {
    contentWidth,
    featureWidth,
    rightWidth,
    showPipeline,
    pipelineGap,
  };
}

export function Header({ startedAt }: HeaderProps) {
  const [{ cols, isSmall }, lifecycle] = useStores(terminalSizeStore, lifecycleStore);
  const { phase, startedAt: lifecycleStartedAt, endedAt, durationMs } = lifecycle;
  const t = useTheme();
  const feature = routerStore.use((s) => (s.screen === 'workflow' ? s.feature : ''));
  const worktreeName = routerStore.use((s) =>
    s.screen === 'workflow' ? s.worktreeName : undefined,
  );
  const layout = getHeaderLayout(cols, isSmall);
  const labelWidth = worktreeName ? worktreeName.length + 3 : 0;
  const featureTextWidth = Math.max(0, layout.featureWidth - labelWidth);

  return (
    <Box width="100%" height={1} overflow="hidden" paddingX={1}>
      <Box width={layout.featureWidth} overflow="hidden">
        {layout.featureWidth > 0 && worktreeName && (
          <Text color={t.warning}>[{worktreeName}] </Text>
        )}
        {featureTextWidth > 0 && (
          <Text color={t.text}>{truncateWithEllipsis(feature, featureTextWidth)}</Text>
        )}
      </Box>
      <Box flexGrow={1} />
      <Box width={layout.rightWidth} justifyContent="flex-end">
        {layout.showPipeline && (
          <Box marginRight={layout.pipelineGap}>
            <PipelineBar phase={phase} />
          </Box>
        )}
        <Box width={TIMER_WIDTH} justifyContent="flex-end">
          <ElapsedClock
            mountedAt={startedAt}
            lifecycleStartedAt={lifecycleStartedAt}
            endedAt={endedAt}
            durationMs={durationMs}
          />
        </Box>
      </Box>
    </Box>
  );
}
