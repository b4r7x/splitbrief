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
import { getActiveRailStage } from '../layout/chrome-rows.js';
import {
  deriveLiveStatus,
  formatStageElapsed,
  stallRunnerHint,
  PAUSED_LIVE_STATUS_VERB,
} from '../display/live-activity.js';
import { colorForTone } from '../display/tone-color.js';
import { useSpinnerFrame } from '../hooks/use-spinner-frame.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { glyph } from '../../../lib/glyphs.js';
import { formatStageLabel } from '../../../core/phase-display.js';
import { buildInputFooterByline } from '../input-footer-byline.js';
import { reviewerSeatLabel } from './runner-label.js';

function joinBylineParts(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => part !== null && part !== undefined && part.length > 0)
    .join(SOFT_SEP);
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
    s.screen === 'workflow' && s.execution.kind === 'local'
      ? s.execution.prepared.runtime.worktreeName
      : undefined,
  );
  const { currentTask, totalTasks, taskCompletionTimes } = useCostStats();
  const etaText = computeEta(taskCompletionTimes, currentTask, totalTasks);
  const advisory = useAdvisory();
  const config = configStore.useConfig();
  const workflow = config.workflow;
  const reviewerSeat = reviewerSeatLabel(config);
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
        reviewerLabel: reviewerSeat === '' ? null : reviewerSeat,
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
  const paused = lifecycle.status === 'paused';
  // Until the continuation prompt parks at a call boundary, Enter/steer would go
  // nowhere — advertise the retry affordance only once the prompt owns the composer.
  const interruptedLead = lifecycle.interruptParked
    ? `${glyph('statusPending')} Interrupted — ⏎ retry${SOFT_SEP}type to steer`
    : `${glyph('statusPending')} Interrupted — finishing current step…`;
  const pausedLead = `${glyph('statusPending')} ${PAUSED_LIVE_STATUS_VERB}`;
  const stall = lifecycle.status === 'running' ? lifecycle.stall : null;
  // stall.since is the warning time; silentMs is the silence already elapsed when
  // the warning fired, so the byline shows the full span since the last output.
  const stalledFor =
    stall !== null ? formatStageElapsed(Date.now() - stall.since + stall.silentMs) : '';
  const stalledLead =
    stall !== null ? `${glyph('statusWarning')} Still working — silent ${stalledFor}` : '';

  // One derivation encodes the interrupted → waiting → stalled → live priority
  // order so the lead text, its color, and its hint can never drift apart.
  const { lead, leadColor, hintText } = interrupted
    ? { lead: interruptedLead, leadColor: t.warning, hintText: null }
    : paused
      ? { lead: pausedLead, leadColor: null, hintText: null }
      : waiting
        ? { lead: waitingLead, leadColor: null, hintText: null }
        : stall !== null
          ? { lead: stalledLead, leadColor: t.warning, hintText: stallRunnerHint(stall.runnerName) }
          : liveStatus !== null
            ? { lead: liveLead, leadColor: colorForTone(liveStatus.tone, t), hintText: null }
            : { lead: stageLead, leadColor: null, hintText: null };

  const queuedText = lifecycle.queueDepth > 0 ? `${lifecycle.queueDepth} queued` : null;

  const byline = buildInputFooterByline({
    cols: width ?? cols,
    lead,
    hintText,
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
        {byline.hint}
        {byline.queued.length > 0 ? <Text color={t.info}>{byline.queued}</Text> : null}
        {byline.rest}
      </Text>
    </Box>
  );
}
