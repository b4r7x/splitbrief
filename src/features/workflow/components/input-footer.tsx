import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useStores } from '../../../stores/use-stores.js';
import { useAdvisory } from '../hooks/use-advisory.js';
import { formatAdvisoryText } from '../../../engine/orchestrator/planning/mode-advisor.js';
import { configStore } from '../../../stores/project/config.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { focusHasResolvableCopy } from '../copy/resolve.js';
import { getActiveRailStage } from '../../../core/rail-stages.js';
import {
  deriveLiveStatus,
  formatStageElapsed,
  stallRunnerHint,
  PAUSED_LIVE_STATUS_VERB,
} from '../display/live-activity.js';
import { colorForTone } from '../display/tone-color.js';
import { deriveBuildProgress, etaText } from '../display/build-progress.js';
import { selectTaskListView, tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { useStopByline } from '../stop/use-stop-byline.js';
import { useSpinnerFrame } from '../../../hooks/use-spinner-frame.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { glyph } from '../../../lib/glyphs.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../../../engine/events/workflow-cancel.js';
import { formatStageLabel } from '../../../core/phase-display.js';
import {
  buildInputFooterByline,
  joinBylineParts,
  stageFractionText,
} from '../input-footer-byline.js';
import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { formatSeatIdentity } from '../../../core/crew/identity.js';
import { useCrewDisplayNames } from '../../../hooks/use-crew-display-names.js';

export function InputFooter({
  width,
  waiting = false,
  byline: givenByline,
}: {
  width?: number | undefined;
  waiting?: boolean | undefined;
  /** A run at rest states where it stands from its record; there is no live status to derive. */
  byline?: string | undefined;
}) {
  const t = useTheme();
  const [lifecycle, { cols }, tasks, tokens, operations] = useStores(
    lifecycleStore,
    terminalSizeStore,
    tasksStore,
    tokensStore,
    operationsStore,
  );
  const worktreeName = routerStore.use((s) =>
    s.screen === 'workflow' && s.execution.kind === 'local'
      ? s.execution.prepared.runtime.worktreeName
      : undefined,
  );
  const taskListView = selectTaskListView(tasks);
  const stopped = useStopByline();
  const advisory = useAdvisory();
  const config = configStore.useConfig();
  const displayNames = useCrewDisplayNames(config);
  const workflow = config.workflow;
  const reviewer = configuredReviewerRunner(config);
  const reviewerSeat = reviewer
    ? formatSeatIdentity(reviewer, displayNames.review ?? displayNames.plan)
    : '';
  const commitStrategy = workflow.git?.commitStrategy ?? 'none';
  const createBranchEnabled = workflow.git?.createBranch ?? false;
  const gitLabel = createBranchEnabled ? `git:branch+${commitStrategy}` : `git:${commitStrategy}`;
  const activeStage = getActiveRailStage(lifecycle.phase);
  const stageText = activeStage ? formatStageLabel(activeStage.stage) : '';
  const fractionText = stageFractionText(taskListView);
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
  const interruptedLead = `${glyph('statusPending')} Interrupted — finishing current step…`;
  const pausedLead = `${glyph('statusPending')} ${PAUSED_LIVE_STATUS_VERB}`;
  // A run that ended without finishing must not reach the stageLead fallback: the pip there is
  // `stageDone`, so the one line that survives at every width would report a completed-looking
  // stage for a run that stopped. `user_cancelled` is the only reason the engine names.
  const userCancelled = lifecycle.reason === WORKFLOW_CANCEL_REASON_USER;
  const stoppedGlyph = glyph(userCancelled ? 'statusCancelled' : 'statusFailed');
  const stoppedWord = userCancelled ? 'Stopped by you' : 'Build failed';
  const stoppedLead = joinBylineParts([`${stoppedGlyph} ${stoppedWord}`, stageCore]);
  const stall = lifecycle.status === 'running' ? lifecycle.stall : null;
  // stall.since is the warning time; silentMs is the silence already elapsed when
  // the warning fired, so the byline shows the full span since the last output.
  const stalledFor =
    stall !== null ? formatStageElapsed(Date.now() - stall.since + stall.silentMs) : '';
  const stalledLead =
    stall !== null ? `${glyph('statusWarning')} Still working — silent ${stalledFor}` : '';

  // One derivation encodes the stop → cancelled → interrupted → waiting → stalled → live
  // priority order so the lead text, its color, and its hint can never drift apart.
  // The stop's own keys are the legend row's job: crowding them onto this row would cost the
  // state its words at 80 columns and print half a key at 60.
  const { lead, leadColor, hintText } = stopped
    ? { lead: `${glyph('statusPending')} ${stopped.lead}`, leadColor: t.warning, hintText: null }
    : lifecycle.status === 'cancelled'
      ? { lead: stoppedLead, leadColor: userCancelled ? t.warning : t.error, hintText: null }
      : interrupted
        ? { lead: interruptedLead, leadColor: t.warning, hintText: null }
        : paused
          ? { lead: pausedLead, leadColor: null, hintText: null }
          : waiting
            ? { lead: waitingLead, leadColor: null, hintText: null }
            : stall !== null
              ? {
                  lead: stalledLead,
                  leadColor: t.warning,
                  hintText: stallRunnerHint(stall.runnerName),
                }
              : liveStatus !== null
                ? { lead: liveLead, leadColor: colorForTone(liveStatus.tone, t), hintText: null }
                : { lead: stageLead, leadColor: null, hintText: null };

  const queuedText = lifecycle.queueDepth > 0 ? `${lifecycle.queueDepth} queued` : null;

  // The build block states this estimate above the composer; the byline quotes that derivation
  // rather than running a second one, and says nothing while there is none — naming the reason
  // is the block's job, and this row drops its tail before it drops the lead.
  const buildEta = deriveBuildProgress({
    tasks,
    tokens,
    lifecycle,
    operations,
    config,
    now: Date.now(),
  }).eta;
  const etaLabel = buildEta.kind === 'estimate' ? etaText(buildEta) : null;

  const byline = buildInputFooterByline({
    cols: width ?? cols,
    lead,
    hintText,
    queuedText,
    // A run that is stopping or parked is not on its way to finishing: an estimate beside that
    // byline would be a prediction about work nobody is doing.
    etaText: stopped === null ? etaLabel : null,
    gitLabel,
    advisoryText:
      advisory !== null && advisory.kind !== 'none' ? formatAdvisoryText(advisory) : null,
    copyHint: copyResolvable ? 'y copy' : null,
    worktreeLabel: worktreeName ? sanitizeTerminalDisplayText(worktreeName) : null,
  });

  if (givenByline !== undefined) {
    return (
      <Box width="100%" paddingX={0} height={1} flexShrink={0}>
        <Text color={t.textDim} wrap="truncate-end">
          {givenByline}
        </Text>
      </Box>
    );
  }

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
