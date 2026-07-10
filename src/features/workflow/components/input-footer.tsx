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
import { routerStore } from '../../../stores/navigation/router.js';
import { focusHasResolvableCopy } from '../copy/resolve.js';
import { getActiveRailStage, getChromeContentWidth } from '../layout/chrome-rows.js';
import { deriveLiveStatus, formatStageElapsed } from '../display/live-activity.js';
import { colorForTone } from '../display/tone-color.js';
import { useSpinnerFrame } from '../hooks/use-spinner-frame.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../../utils/display-text.js';
import { glyph } from '../../../lib/glyphs.js';

export interface InputFooterBylineInput {
  cols: number;
  lead: string;
  etaText: string | null;
  gitLabel: string;
  advisoryText: string | null;
  copyHint?: string | null;
  worktreeLabel?: string | null;
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

  const candidates = [
    joinBylineParts([input.lead, input.etaText, input.gitLabel, input.advisoryText]),
    joinBylineParts([input.lead, input.etaText, input.gitLabel]),
    joinBylineParts([input.lead, input.gitLabel]),
    joinBylineParts([input.lead]),
  ];

  const chosenCore =
    candidates.find((candidate) => bylineCells(candidate) <= width) ??
    truncateTerminalDisplayText(input.lead, width);

  let line = chosenCore;

  // The copy hint is metadata: it is the first accessory to go under width pressure, degrading
  // `y copy`, then bare `y`, then gone, and only appended when the richest core still leaves room.
  const copyFull = input.copyHint && input.copyHint.length > 0 ? input.copyHint : null;
  if (copyFull) {
    const copyBare = copyFull.split(' ')[0] ?? copyFull;
    const copyVariants = copyBare === copyFull ? [copyFull] : [copyFull, copyBare];
    for (const variant of copyVariants) {
      const combined = joinBylineParts([line, variant]);
      if (bylineCells(combined) <= width) {
        line = combined;
        break;
      }
    }
  }

  // The worktree name is trailing identity, appended last so it yields to every hint above and
  // truncates to whatever room is left rather than pushing the core out.
  const worktree =
    input.worktreeLabel && input.worktreeLabel.length > 0 ? input.worktreeLabel : null;
  if (worktree) {
    const labeled = `${glyph('cursor')} ${worktree}`;
    const remaining = width - bylineCells(line) - bylineCells(SOFT_SEP);
    if (remaining > 0) {
      const fitted =
        bylineCells(labeled) <= remaining
          ? labeled
          : truncateTerminalDisplayText(labeled, remaining);
      line = joinBylineParts([line, fitted]);
    }
  }

  return line;
}

export function InputFooter({
  width,
  waiting = false,
}: {
  width?: number | undefined;
  waiting?: boolean | undefined;
}) {
  const t = useTheme();
  const [lifecycle, { cols }] = useStores(lifecycleStore, terminalSizeStore);
  const worktreeName = routerStore.use((s) =>
    s.screen === 'workflow' ? s.worktreeName : undefined,
  );
  const { currentTask, totalTasks, taskCompletionTimes } = useCostStats();
  const etaText = computeEta(taskCompletionTimes, currentTask, totalTasks);
  const advisory = useAdvisory();
  const workflow = configStore.useConfig().workflow;
  const commitStrategy = workflow.git?.commitStrategy ?? 'none';
  const createBranchEnabled = workflow.git?.createBranch ?? false;
  const gitLabel = createBranchEnabled ? `git:branch+${commitStrategy}` : `git:${commitStrategy}`;
  const activeStage = getActiveRailStage(lifecycle.phase);
  const stageText = activeStage?.stage ?? '';
  const fractionText = totalTasks > 0 ? `${currentTask}/${totalTasks}` : '';
  // Only advertise `y copy` when the focused region actually resolves a value, so the affordance
  // never promises a yank that would toast "Nothing to copy".
  const focus = focusStore.use((f) => f);
  const copyResolvable = focusHasResolvableCopy(focus);

  const liveStatus =
    lifecycle.status === 'running' && !waiting
      ? deriveLiveStatus({
          phase: lifecycle.phase,
          cancelled: lifecycle.cancelled,
          startedAt: lifecycle.startedAt,
          phaseFirstSeenTs: lifecycle.phaseFirstSeenTs,
        })
      : null;
  const live = liveStatus !== null;
  const { frame } = useSpinnerFrame(live);

  const stageCore = [stageText, fractionText].filter((part) => part.length > 0).join(' ');
  const stageLead = stageCore.length > 0 ? `${glyph('stageDone')} ${stageCore}` : '';
  const waitingLead = joinBylineParts([`${glyph('statusPending')} waiting for you`, stageCore]);
  const elapsed =
    liveStatus !== null && liveStatus.stageStart > 0
      ? formatStageElapsed(Date.now() - liveStatus.stageStart)
      : '';
  const liveLead =
    liveStatus !== null
      ? [`${frame} ${liveStatus.verb}`, elapsed].filter((part) => part.length > 0).join(' ')
      : '';
  const lead = waiting ? waitingLead : liveStatus !== null ? liveLead : stageLead;

  const byline = buildInputFooterByline({
    cols: width ?? cols,
    lead,
    etaText,
    gitLabel,
    advisoryText:
      advisory !== null && advisory.kind !== 'none' ? formatAdvisoryText(advisory) : null,
    copyHint: copyResolvable ? 'y copy' : null,
    worktreeLabel: worktreeName ? sanitizeTerminalDisplayText(worktreeName) : null,
  });

  const leadText = byline.startsWith(lead) ? lead : byline;
  const restText = byline.startsWith(lead) ? byline.slice(lead.length) : '';

  return (
    <Box width="100%" paddingX={0} height={1} flexShrink={0}>
      <Text color={t.textDim} wrap="truncate-end">
        {liveStatus !== null ? (
          <Text color={colorForTone(liveStatus.tone, t)}>{leadText}</Text>
        ) : (
          leadText
        )}
        {restText}
      </Text>
    </Box>
  );
}
