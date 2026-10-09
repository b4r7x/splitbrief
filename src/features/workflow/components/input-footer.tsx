import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useStores } from '../../../stores/use-stores.js';
import { configStore } from '../../../stores/project/config.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { preparationStore } from '../../../stores/navigation/preparation.js';
import { getActiveRailStage } from '../../../core/rail-stages.js';
import { deriveLiveStatus, PAUSED_LIVE_STATUS_VERB } from '../display/live-activity.js';
import { colorForTone } from '../display/tone-color.js';
import { runnerSilenceMs, silenceTail, silenceText } from '../display/build-progress.js';
import { formatElapsedClock } from '../../../utils/format-time.js';
import {
  selectRunningBrief,
  selectTaskListView,
  tasksStore,
} from '../../../stores/workflow/tasks.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { useStopByline } from '../stop/use-stop-byline.js';
import { useSpinnerFrame } from '../../../hooks/use-spinner-frame.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { glyph } from '../../../lib/glyphs.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';
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
import { controlsStore } from '../../../stores/ui/controls.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { deriveWorkflowDisplay } from '../display/workflow-status.js';

export function InputFooter({
  width,
  waiting = false,
  buildBlockShown = false,
  byline: givenByline,
}: {
  width?: number | undefined;
  waiting?: boolean | undefined;
  /** The build block is on screen, and its freshness line states the seat's silence. */
  buildBlockShown?: boolean | undefined;
  /** A run at rest states where it stands from its record; there is no live status to derive. */
  byline?: string | undefined;
}) {
  const t = useTheme();
  const [lifecycle, { cols }, tasks, operations, controls, approval, recovery] = useStores(
    lifecycleStore,
    terminalSizeStore,
    tasksStore,
    operationsStore,
    controlsStore,
    approvalPromptStore,
    recoveryNoticeStore,
  );
  const worktreeName = routerStore.use((s) =>
    s.screen === 'workflow' && s.execution.kind === 'local'
      ? s.execution.prepared.runtime.worktreeName
      : undefined,
  );
  const taskListView = selectTaskListView(tasks);
  const stopped = useStopByline();
  const config = configStore.useConfig();
  const displayNames = useCrewDisplayNames(config);
  const reviewer = configuredReviewerRunner(config);
  const reviewerSeat = reviewer
    ? formatSeatIdentity({ seat: reviewer, displayName: displayNames.review ?? displayNames.plan })
    : '';
  const activeStage = getActiveRailStage(lifecycle.phase);
  const stageText = activeStage ? formatStageLabel(activeStage.stage) : '';
  const fractionText = stageFractionText(taskListView);

  // Re-entering a run at rest checks its tools first. That wait belongs on this row — the run
  // itself stays on screen, the composer beside it stays live, and the word is the request's own.
  const checkingStage = preparationStore.use((state) =>
    state.kind === 'checking' ? state.stage : null,
  );

  const display = deriveWorkflowDisplay({
    status: lifecycle.status,
    cancelled: lifecycle.cancelled,
    pendingQuestion: waiting || controls.inputMode !== 'normal',
    pendingRecovery: recovery.issue !== null,
    pendingApproval: approval.status === 'pending',
  });
  const recoveryWaiting = recovery.issue !== null && controls.inputMode === 'question';
  const recoveryStopped = recovery.issue !== null && !recoveryWaiting;
  const liveStatus =
    waiting || !display.animate
      ? null
      : deriveLiveStatus({
          phase: lifecycle.phase,
          status: lifecycle.status,
          cancelled: lifecycle.cancelled,
          startedAt: lifecycle.startedAt,
          phaseFirstSeenTs: lifecycle.phaseFirstSeenTs,
          waitedMs: lifecycle.waitedMs ?? {},
          resumedAt: lifecycle.resumedAt ?? null,
          reviewerLabel: reviewerSeat === '' ? null : reviewerSeat,
          plannerCall: lifecycle.plannerCall ?? null,
          plannerCallStartedTs: lifecycle.plannerCallStartedTs ?? null,
          suiteStage: operations.suiteStage ?? null,
          activeOperation: operations.active,
        });
  const { frame } = useSpinnerFrame(display.animate || checkingStage !== null);

  const stageCore = [stageText, fractionText].filter((part) => part.length > 0).join(' ');
  const stageLead = stageCore.length > 0 ? `${glyph('stageDone')} ${stageCore}` : '';
  const waitingLead = joinBylineParts([
    `${glyph('statusPending')} Waiting for your answer`,
    stageCore,
  ]);
  const elapsed =
    liveStatus !== null && liveStatus.stageStart > 0
      ? formatElapsedClock(Date.now() - liveStatus.stageStart - liveStatus.waitedMs)
      : '';
  const liveLead =
    liveStatus !== null
      ? `${frame} ${
          operations.active?.apiRuntimeStatus?.phase === 'waiting-first-response'
            ? 'Waiting for response'
            : liveStatus.verb
        }`
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
  const recoveryStoppedLead = `${glyph('statusFailed')} Run stopped`;
  // The silence span and what the seat does through it come from the derivation the block's
  // freshness line reads, so the two surfaces state one fact in one wording; the block prints it
  // while it is on screen, this lead otherwise.
  const stall = lifecycle.status === 'running' && !buildBlockShown ? lifecycle.stall : null;
  const stalledLead =
    stall === null
      ? ''
      : `${glyph('statusWarning')} ${silenceText(runnerSilenceMs(lifecycle, Date.now()) ?? 0, null)}`;
  const stalledHint = stall === null ? null : silenceTail(operations.active, stall);

  // An actionable prompt takes precedence over the lifecycle state it interrupted.
  // The stop's own keys are the legend row's job: crowding them onto this row would cost the
  // state its words at 80 columns and print half a key at 60.
  // A lead's clock is kept apart from its words, so a byline too narrow for both cuts the words.
  const { lead, leadClock, leadColor, hintText } = recoveryWaiting
    ? { lead: `${glyph('statusPending')} Choose how to continue`, leadColor: null, hintText: null }
    : stopped
      ? {
          lead: `${glyph('statusPending')} ${stopped.lead}`,
          leadClock: stopped.clock,
          leadColor: t.warning,
          hintText: null,
        }
      : recoveryStopped
        ? { lead: recoveryStoppedLead, leadColor: t.error, hintText: null }
        : waiting || approval.status === 'pending'
          ? { lead: waitingLead, leadColor: null, hintText: null }
          : lifecycle.status === 'cancelled'
            ? { lead: stoppedLead, leadColor: userCancelled ? t.warning : t.error, hintText: null }
            : interrupted
              ? { lead: interruptedLead, leadColor: t.warning, hintText: null }
              : paused
                ? { lead: pausedLead, leadColor: null, hintText: null }
                : stall !== null
                  ? {
                      lead: stalledLead,
                      leadColor: t.warning,
                      hintText: stalledHint,
                    }
                  : liveStatus !== null
                    ? {
                        lead: liveLead,
                        leadClock: elapsed,
                        leadColor: colorForTone(liveStatus.tone, t),
                        hintText: null,
                      }
                    : { lead: stageLead, leadColor: null, hintText: null };

  // During a brief the composer is queueing for the boundary that brief owns, so the footer names
  // it: "queued for after T003" says where the text lands, where a bare count would not. Outside a
  // brief — planning, final review, a run at rest — the queue is the planner's or reviewer's and
  // the count is the whole truth.
  const runningBriefId = selectRunningBrief(tasks, lifecycle.phase).current?.id ?? null;
  const queuedText =
    lifecycle.queueDepth > 0
      ? runningBriefId !== null
        ? `queued for after ${runningBriefId}`
        : `${lifecycle.queueDepth} queued`
      : null;

  const byline = buildInputFooterByline({
    // Raw width in; the builder owns the framed text measure.
    cols: Math.max(1, width ?? cols),
    lead,
    leadClock,
    hintText,
    queuedText,
    worktreeLabel: worktreeName ? sanitizeTerminalDisplayText(worktreeName) : null,
  });

  if (checkingStage !== null) {
    return (
      <Box width="100%" height={1} flexShrink={0}>
        <Text color={t.textDim} wrap="truncate-end">
          {joinBylineParts([`${frame} ${checkingStage}`, 'esc cancel'])}
        </Text>
      </Box>
    );
  }

  // The only byline with no pip of its own: it keeps an empty mark slot and opens its words on the
  // text column, where the live bylines' words and the legend's keys open too.
  if (givenByline !== undefined && stopped === null) {
    return (
      <Box width="100%" height={1} flexShrink={0}>
        <Text color={t.textDim} wrap="truncate-end">
          {' '.repeat(MARK_SLOT_CELLS)}
          {givenByline}
        </Text>
      </Box>
    );
  }

  return (
    <Box width="100%" height={1} flexShrink={0}>
      <Text color={t.textDim} wrap="truncate-end">
        {leadColor !== null ? <Text color={leadColor}>{byline.lead}</Text> : byline.lead}
        {byline.hint}
        {byline.queued.length > 0 ? <Text color={t.info}>{byline.queued}</Text> : null}
        {byline.rest}
      </Text>
    </Box>
  );
}
