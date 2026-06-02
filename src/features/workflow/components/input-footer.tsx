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
import { truncateWithEllipsis } from '../../../utils/truncate.js';

const FOOTER_SEPARATOR = ' · ';
const FOOTER_COMPACT_CONTENT_WIDTH = 88;

interface InputFooterLayoutInput {
  cols: number;
  isAttachedClient: boolean;
  advisoryText: string | null;
  taskText: string;
  queueText: string | null;
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

export function buildInputFooterLayout(input: InputFooterLayoutInput): InputFooterLayout {
  const contentWidth = getChromeContentWidth(input.cols);
  const isCompact = contentWidth < FOOTER_COMPACT_CONTENT_WIDTH;
  const controlParts = input.isAttachedClient
    ? ['Ctrl+D detach']
    : ['Ctrl+C abort', isCompact ? null : 'Ctrl+C again exit'];
  const right = joinFooterParts([
    input.taskText,
    isCompact ? null : input.queueText,
    isCompact ? null : input.gitLabel,
  ]);
  const baseLeft = joinFooterParts(controlParts);
  const gap = right ? 4 : 0;
  const advisoryBudget =
    contentWidth - baseLeft.length - right.length - gap - FOOTER_SEPARATOR.length;
  const advisoryText =
    input.advisoryText && contentWidth >= 60 && advisoryBudget >= 12
      ? truncateWithEllipsis(input.advisoryText, advisoryBudget)
      : null;
  const left = joinFooterParts([...controlParts, advisoryText]);
  const leftBudget = right ? Math.max(1, contentWidth - right.length - gap) : contentWidth;

  const fittedLeft = left.length <= leftBudget ? left : truncateWithEllipsis(left, leftBudget);

  if (!right || fittedLeft.length + right.length + gap <= contentWidth) {
    return { left: fittedLeft, right };
  }

  const rightBudget = Math.max(
    1,
    contentWidth - Math.min(fittedLeft.length, Math.floor(contentWidth / 2)) - gap,
  );
  const fittedRight = truncateWithEllipsis(right, rightBudget);
  return {
    left: truncateWithEllipsis(left, Math.max(1, contentWidth - fittedRight.length - gap)),
    right: fittedRight,
  };
}

export function InputFooter() {
  const t = useTheme();
  const [{ queueDepth }, { cols }] = useStores(lifecycleStore, terminalSizeStore);
  const isAttachedClient = routerStore.use(
    (s) => s.screen === 'workflow' && s.attach !== undefined,
  );
  const { currentTask, totalTasks, taskCompletionTimes } = useCostStats();
  const etaText = computeEta(taskCompletionTimes, currentTask, totalTasks);
  const advisory = useAdvisory();
  const workflow = configStore.useConfig().workflow;
  const commitStrategy = workflow.git?.commitStrategy ?? workflow.commitStrategy ?? 'none';
  const createBranchEnabled = workflow.git?.createBranch ?? false;
  const gitLabel = createBranchEnabled ? `git: branch+${commitStrategy}` : `git: ${commitStrategy}`;
  const taskText = `Task ${currentTask}/${totalTasks}${etaText ? ` · ${etaText}` : ''}`;
  const layout = buildInputFooterLayout({
    cols,
    isAttachedClient,
    advisoryText:
      advisory !== null && advisory.kind !== 'none' ? formatAdvisoryText(advisory) : null,
    taskText,
    queueText: queueDepth > 0 ? `queue: ${queueDepth}` : null,
    gitLabel,
  });

  return (
    <Box width="100%" paddingX={1} justifyContent="space-between" height={1} flexShrink={0}>
      <Text color={t.textDim}>{layout.left}</Text>
      {layout.right && <Text color={t.textDim}>{layout.right}</Text>}
    </Box>
  );
}
