import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { useCostStats } from '../hooks/use-cost-stats.js';
import { computeEta } from './cost/compute-eta.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useStores } from '../../../stores/use-stores.js';
import { useAdvisory } from '../hooks/use-advisory.js';
import { formatAdvisoryText } from '../../../engine/orchestrator/planning/mode-advisor.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../../utils/display-text.js';

const FOOTER_SEPARATOR = ' · ';
const FOOTER_GAP_CELLS = 4;
const FOOTER_COMPACT_CONTENT_WIDTH = 88;

interface InputFooterLayoutInput {
  cols: number;
  isAttachedClient: boolean;
  advisoryText: string | null;
  taskText: string;
  queueCountText: string | null;
  queuePreviewText: string | null;
  gitLabel: string;
}

export interface InputFooterLayout {
  left: string;
  right: string;
}

function joinFooterParts(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => part !== null && part !== undefined && part.length > 0)
    .join(FOOTER_SEPARATOR);
}

function footerCellWidth(text: string): number {
  return getTerminalCellWidth(text);
}

function fitsFooterCells(text: string, maxCells: number): boolean {
  return footerCellWidth(text) <= maxCells;
}

function truncateFooterText(text: string, maxCells: number): string {
  return truncateTerminalDisplayText(text, maxCells);
}

function buildQueueText(
  queueCountText: string | null,
  queuePreviewText: string | null,
  isCompact: boolean,
): string | null {
  if (!queueCountText) return null;
  if (isCompact || !queuePreviewText) return queueCountText;
  return `${queueCountText} - ${queuePreviewText}`;
}

function buildRightStatus(input: InputFooterLayoutInput, contentWidth: number): string {
  const isCompact = contentWidth < FOOTER_COMPACT_CONTENT_WIDTH;
  const queueText = buildQueueText(input.queueCountText, input.queuePreviewText, isCompact);
  const full = joinFooterParts([input.taskText, queueText, isCompact ? null : input.gitLabel]);
  if (fitsFooterCells(full, contentWidth)) return full;

  if (input.queueCountText) {
    const compactQueue = joinFooterParts([input.taskText, input.queueCountText]);
    if (fitsFooterCells(compactQueue, contentWidth)) return compactQueue;

    const separatorWidth = footerCellWidth(FOOTER_SEPARATOR);
    const queueWidth = footerCellWidth(input.queueCountText);
    if (queueWidth <= contentWidth) {
      const taskBudget = contentWidth - queueWidth - separatorWidth;
      if (taskBudget > 1) {
        return joinFooterParts([
          truncateFooterText(input.taskText, taskBudget),
          input.queueCountText,
        ]);
      }
      return input.queueCountText;
    }

    return truncateFooterText(input.queueCountText, contentWidth);
  }

  return truncateFooterText(full, contentWidth);
}

export function buildInputFooterLayout(input: InputFooterLayoutInput): InputFooterLayout {
  const contentWidth = getChromeContentWidth(input.cols);
  const isCompact = contentWidth < FOOTER_COMPACT_CONTENT_WIDTH;
  const controlParts = input.isAttachedClient
    ? ['Ctrl+D detach']
    : ['Ctrl+C abort', isCompact ? null : 'Ctrl+C again exit'];
  const right = buildRightStatus(input, contentWidth);
  const baseLeft = joinFooterParts(controlParts);
  const gap = right ? FOOTER_GAP_CELLS : 0;
  const baseLeftWidth = footerCellWidth(baseLeft);
  const rightWidth = footerCellWidth(right);
  const advisoryBudget =
    contentWidth - baseLeftWidth - rightWidth - gap - footerCellWidth(FOOTER_SEPARATOR);
  const advisoryText =
    input.advisoryText && contentWidth >= 60 && advisoryBudget >= 12
      ? truncateFooterText(input.advisoryText, advisoryBudget)
      : null;
  const left = joinFooterParts([...controlParts, advisoryText]);
  const leftBudget = right ? Math.max(0, contentWidth - rightWidth - gap) : contentWidth;

  const fittedLeft = fitsFooterCells(left, leftBudget)
    ? left
    : truncateFooterText(left, leftBudget);

  if (!right || footerCellWidth(fittedLeft) + rightWidth + gap <= contentWidth) {
    return { left: fittedLeft, right };
  }

  const rightBudget = Math.max(
    1,
    contentWidth - Math.min(footerCellWidth(fittedLeft), Math.floor(contentWidth / 2)) - gap,
  );
  const fittedRight = truncateFooterText(right, rightBudget);
  return {
    left: truncateFooterText(left, Math.max(0, contentWidth - footerCellWidth(fittedRight) - gap)),
    right: fittedRight,
  };
}

export function InputFooter() {
  const t = useTheme();
  const [{ queueDepth, queuePreviews }, { cols }] = useStores(lifecycleStore, terminalSizeStore);
  const isAttachedClient = routerStore.use(
    (s) => s.screen === 'workflow' && s.attach !== undefined,
  );
  const { currentTask, totalTasks, taskCompletionTimes } = useCostStats();
  const etaText = computeEta(taskCompletionTimes, currentTask, totalTasks);
  const advisory = useAdvisory();
  const workflow = configStore.useConfig().workflow;
  const commitStrategy = workflow.git?.commitStrategy ?? 'none';
  const createBranchEnabled = workflow.git?.createBranch ?? false;
  const gitLabel = createBranchEnabled ? `git: branch+${commitStrategy}` : `git: ${commitStrategy}`;
  const taskText = `Task ${currentTask}/${totalTasks}${etaText ? ` · ${etaText}` : ''}`;
  const latestQueuePreview =
    queuePreviews.length > 0 ? (queuePreviews[queuePreviews.length - 1]?.preview ?? null) : null;
  const queueCountText = queueDepth > 0 ? `queue: ${queueDepth}` : null;
  const layout = buildInputFooterLayout({
    cols,
    isAttachedClient,
    advisoryText:
      advisory !== null && advisory.kind !== 'none' ? formatAdvisoryText(advisory) : null,
    taskText,
    queueCountText,
    queuePreviewText: latestQueuePreview,
    gitLabel,
  });

  return (
    <Box width="100%" paddingX={1} justifyContent="space-between" height={1} flexShrink={0}>
      <Text color={t.textDim}>{layout.left}</Text>
      {layout.right && <Text color={t.textDim}>{layout.right}</Text>}
    </Box>
  );
}
