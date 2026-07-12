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
import { formatStageLabel } from '../../../core/phase-display.js';

export interface InputFooterBylineInput {
  cols: number;
  lead: string;
  queuedText: string | null;
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

export interface InputFooterByline {
  lead: string;
  queued: string;
  rest: string;
}

export function buildInputFooterByline(input: InputFooterBylineInput): InputFooterByline {
  const width = getChromeContentWidth(input.cols);
  const queuedPart = input.queuedText && input.queuedText.length > 0 ? input.queuedText : null;

  // Widest first; advisory, then eta, then git degrade first. Each candidate records whether
  // the queued segment survived at that width so the caller can color it independently.
  const candidates: Array<{ queued: boolean; tail: (string | null)[] }> = [
    { queued: true, tail: [input.etaText, input.gitLabel, input.advisoryText] },
    { queued: true, tail: [input.etaText, input.gitLabel] },
    { queued: true, tail: [input.gitLabel] },
    { queued: true, tail: [] },
    { queued: false, tail: [] },
  ];

  let leadOut = input.lead;
  let queuedIncluded = false;
  let tail: (string | null)[] = [];
  let line = '';
  let matched = false;

  for (const candidate of candidates) {
    const candidateStr = joinBylineParts([
      input.lead,
      candidate.queued ? queuedPart : null,
      ...candidate.tail,
    ]);
    if (bylineCells(candidateStr) <= width) {
      line = candidateStr;
      queuedIncluded = candidate.queued;
      tail = candidate.tail;
      matched = true;
      break;
    }
  }

  if (!matched) {
    leadOut = truncateTerminalDisplayText(input.lead, width);
    line = leadOut;
  }

  const queuedOut =
    queuedIncluded && queuedPart !== null
      ? leadOut.length > 0
        ? `${SOFT_SEP}${queuedPart}`
        : queuedPart
      : '';
  const restCore = joinBylineParts(tail);
  let restOut =
    restCore.length > 0
      ? leadOut.length > 0 || queuedOut.length > 0
        ? `${SOFT_SEP}${restCore}`
        : restCore
      : '';

  // The copy hint is metadata: it is the first accessory to go under width pressure, degrading
  // `y copy`, then bare `y`, then gone, and only appended when the richest core still leaves room.
  const copyFull = input.copyHint && input.copyHint.length > 0 ? input.copyHint : null;
  if (copyFull) {
    const copyBare = copyFull.split(' ')[0] ?? copyFull;
    const copyVariants = copyBare === copyFull ? [copyFull] : [copyFull, copyBare];
    for (const variant of copyVariants) {
      const combined = joinBylineParts([line, variant]);
      if (bylineCells(combined) <= width) {
        restOut += combined.slice(line.length);
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
      const combined = joinBylineParts([line, fitted]);
      restOut += combined.slice(line.length);
      line = combined;
    }
  }

  return { lead: leadOut, queued: queuedOut, rest: restOut };
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
  const stageText = activeStage ? formatStageLabel(activeStage.stage) : '';
  const fractionText = totalTasks > 0 ? `${currentTask}/${totalTasks}` : '';
  // Only advertise `y copy` when the focused region actually resolves a value, so the affordance
  // never promises a yank that would toast "Nothing to copy".
  const focus = focusStore.use((f) => f);
  const copyResolvable = focusHasResolvableCopy(focus);

  const liveStatus = waiting
    ? null
    : deriveLiveStatus({
        phase: lifecycle.phase,
        status: lifecycle.status,
        cancelled: lifecycle.cancelled,
        startedAt: lifecycle.startedAt,
        phaseFirstSeenTs: lifecycle.phaseFirstSeenTs,
      });
  const live = liveStatus !== null;
  const { frame } = useSpinnerFrame(live);

  const stageCore = [stageText, fractionText].filter((part) => part.length > 0).join(' ');
  const stageLead = stageCore.length > 0 ? `${glyph('stageDone')} ${stageCore}` : '';
  const waitingLead = joinBylineParts([`${glyph('statusPending')} Waiting for you`, stageCore]);
  const elapsed =
    liveStatus !== null && liveStatus.stageStart > 0
      ? formatStageElapsed(Date.now() - liveStatus.stageStart)
      : '';
  const liveLead =
    liveStatus !== null
      ? [`${frame} ${liveStatus.verb}`, elapsed].filter((part) => part.length > 0).join(' ')
      : '';

  const interrupted = lifecycle.status === 'interrupted';
  // Until the continuation prompt parks at a call boundary, Enter/steer would go
  // nowhere — advertise the retry affordance only once the prompt owns the composer.
  const interruptedLead = lifecycle.interruptParked
    ? `${glyph('statusPending')} Interrupted — ⏎ retry${SOFT_SEP}type to steer`
    : `${glyph('statusPending')} Interrupted — finishing current step…`;
  const stall = lifecycle.status === 'running' ? lifecycle.stall : null;
  // stall.since is the warning time; silentMs is the silence already elapsed when
  // the warning fired, so the byline shows the full span since the last output.
  const stalledFor =
    stall !== null ? formatStageElapsed(Date.now() - stall.since + stall.silentMs) : '';
  const stalledLead =
    stall !== null ? `${glyph('statusWarning')} Still working — silent ${stalledFor}` : '';

  // One derivation encodes the interrupted → waiting → stalled → live priority
  // order so the lead text and its color can never drift apart.
  const { lead, leadColor } = interrupted
    ? { lead: interruptedLead, leadColor: t.warning }
    : waiting
      ? { lead: waitingLead, leadColor: null }
      : stall !== null
        ? { lead: stalledLead, leadColor: t.warning }
        : liveStatus !== null
          ? { lead: liveLead, leadColor: colorForTone(liveStatus.tone, t) }
          : { lead: stageLead, leadColor: null };

  const queuedText = lifecycle.queueDepth > 0 ? `${lifecycle.queueDepth} queued` : null;

  const byline = buildInputFooterByline({
    cols: width ?? cols,
    lead,
    queuedText,
    etaText,
    gitLabel,
    advisoryText:
      advisory !== null && advisory.kind !== 'none' ? formatAdvisoryText(advisory) : null,
    copyHint: copyResolvable ? 'y copy' : null,
    worktreeLabel: worktreeName ? sanitizeTerminalDisplayText(worktreeName) : null,
  });

  return (
    <Box width="100%" paddingX={0} height={1} flexShrink={0}>
      <Text color={t.textDim} wrap="truncate-end">
        {leadColor !== null ? <Text color={leadColor}>{byline.lead}</Text> : byline.lead}
        {byline.queued.length > 0 ? <Text color={t.info}>{byline.queued}</Text> : null}
        {byline.rest}
      </Text>
    </Box>
  );
}
