import { Box, Text } from 'ink';
import { SOFT_SEP } from '../../../components/separators.js';
import { useTheme } from '../../../components/theme.js';
import { useCostStats } from '../hooks/use-cost-stats.js';
import { computeEta } from './cost/compute-eta.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useStores } from '../../../stores/use-stores.js';
import { useAdvisory } from '../hooks/use-advisory.js';
import { formatAdvisoryText } from '../../../engine/orchestrator/planning/mode-advisor.js';
import { configStore } from '../../../stores/project/config.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { focusHasResolvableCopy } from '../copy/resolve.js';
import { getChromeContentWidth, getRailStages } from '../layout/chrome-rows.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { glyph } from '../../../lib/glyphs.js';

export interface InputFooterBylineInput {
  cols: number;
  stageText: string;
  fractionText: string;
  etaText: string | null;
  gitLabel: string;
  advisoryText: string | null;
  copyHint?: string | null;
}

function joinBylineParts(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => part !== null && part !== undefined && part.length > 0)
    .join(SOFT_SEP);
}

function bylineCells(text: string): number {
  return getTerminalCellWidth(text);
}

export function buildInputFooterByline(input: InputFooterBylineInput): string {
  const width = getChromeContentWidth(input.cols);
  const core = [input.stageText, input.fractionText].filter((part) => part.length > 0).join(' ');
  const floor = input.fractionText.length > 0 ? input.fractionText : input.stageText;
  const lead = (text: string) => (text.length > 0 ? `${glyph('stageDone')} ${text}` : '');

  const candidates = [
    joinBylineParts([lead(core), input.etaText, input.gitLabel, input.advisoryText]),
    joinBylineParts([lead(core), input.etaText, input.gitLabel]),
    joinBylineParts([lead(core), input.gitLabel]),
    joinBylineParts([lead(core)]),
    joinBylineParts([lead(floor)]),
  ];

  const chosenCore =
    candidates.find((candidate) => bylineCells(candidate) <= width) ??
    truncateTerminalDisplayText(lead(floor), width);

  // The copy hint is metadata: it is the first accessory to go under width pressure, degrading
  // `y copy`, then bare `y`, then gone, and only appended when the richest core still leaves room.
  const copyFull = input.copyHint && input.copyHint.length > 0 ? input.copyHint : null;
  if (!copyFull) return chosenCore;

  const copyBare = copyFull.split(' ')[0] ?? copyFull;
  const copyVariants = copyBare === copyFull ? [copyFull] : [copyFull, copyBare];
  for (const variant of copyVariants) {
    const combined = joinBylineParts([chosenCore, variant]);
    if (bylineCells(combined) <= width) return combined;
  }
  return chosenCore;
}

export function InputFooter({ width }: { width?: number | undefined }) {
  const t = useTheme();
  const [{ phase }, { cols }] = useStores(lifecycleStore, terminalSizeStore);
  const { currentTask, totalTasks, taskCompletionTimes } = useCostStats();
  const etaText = computeEta(taskCompletionTimes, currentTask, totalTasks);
  const advisory = useAdvisory();
  const workflow = configStore.useConfig().workflow;
  const commitStrategy = workflow.git?.commitStrategy ?? 'none';
  const createBranchEnabled = workflow.git?.createBranch ?? false;
  const gitLabel = createBranchEnabled ? `git:branch+${commitStrategy}` : `git:${commitStrategy}`;
  const activeStage = getRailStages(phase).find((stage) => stage.status === 'active');
  const stageText = activeStage ? activeStage.stage : '';
  const fractionText = totalTasks > 0 ? `${currentTask}/${totalTasks}` : '';
  // Only advertise `y copy` when the focused region actually resolves a value, so the affordance
  // never promises a yank that would toast "Nothing to copy".
  const focus = focusStore.use((f) => f);
  const copyResolvable = focusHasResolvableCopy(focus);

  const byline = buildInputFooterByline({
    cols: width ?? cols,
    stageText,
    fractionText,
    etaText,
    gitLabel,
    advisoryText:
      advisory !== null && advisory.kind !== 'none' ? formatAdvisoryText(advisory) : null,
    copyHint: copyResolvable ? 'y copy' : null,
  });

  return (
    <Box width="100%" paddingX={1} paddingBottom={1} height={2} flexShrink={0}>
      <Text color={t.textDim} wrap="truncate-end">
        {byline}
      </Text>
    </Box>
  );
}
