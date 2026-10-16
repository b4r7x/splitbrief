import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useStores } from '../../../stores/use-stores.js';
import { configStore } from '../../../stores/project/config.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { preparationStore } from '../../../stores/navigation/preparation.js';
import { getActiveRailStage, phaseStage, railStageSeat } from '../../../core/rail-stages.js';
import { deriveLiveStatus } from '../display/live-activity.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { TextSpans } from '../../../components/text-spans.js';
import { runnerSilenceMs, silenceTail, silenceText } from '../display/build-progress.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { formatElapsedClock } from '../../../utils/format-time.js';
import {
  selectRunningBrief,
  selectTaskListView,
  tasksStore,
} from '../../../stores/workflow/tasks.js';
import {
  operationsStore,
  selectScheduledReview,
} from '../../../stores/workflow/operations/state.js';
import { useStopByline } from '../stop/use-stop-byline.js';
import { useSpinnerFrame } from '../../../hooks/use-spinner-frame.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  segmentsForRowText,
  truncateTerminalDisplayText,
} from '../../../utils/display-text.js';
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
import { queueCopy } from '../queue-copy.js';
import { messageSeat } from '../../../core/queue-state.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { deriveWorkflowDisplay } from '../display/workflow-status.js';
import { stateTone } from '../../../core/theme/state-tone.js';

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
  byline?: readonly ConversationRowSegment[] | undefined;
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
  const atRestStatus = routerStore.use((s) =>
    s.screen === 'workflow' && s.execution.kind === 'at-rest' ? s.run.status.kind : null,
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
  // A run on screen that is paused with no stop of its own and no record byline has been
  // continued: the engine is reaping, restoring and re-entering before its first event.
  const resuming = lifecycle.status === 'paused' && stopped === null && givenByline === undefined;
  const { frame } = useSpinnerFrame(display.animate || checkingStage !== null || resuming);

  const stageSeat = activeStage === null ? null : railStageSeat(activeStage.stage);
  const stageParts: ConversationRowSegment[] = [
    ...(stageText === ''
      ? []
      : ([
          { text: stageText, tone: stageSeat === null ? 'text' : CREW_SEAT_ROLES[stageSeat] },
        ] satisfies ConversationRowSegment[])),
    ...(fractionText === ''
      ? []
      : ([
          { text: `${stageText === '' ? '' : ' '}${fractionText}`, tone: 'textDim' },
        ] satisfies ConversationRowSegment[])),
  ];
  const stageLead: ConversationRowSegment[] =
    stageParts.length === 0
      ? []
      : [{ text: `${glyph('stageDone')} `, tone: stateTone('passed') }, ...stageParts];
  const stageTail: ConversationRowSegment[] =
    stageParts.length === 0 ? [] : [{ text: SOFT_SEP, tone: 'textDim' }, ...stageParts];
  const waitingLead: ConversationRowSegment[] = [
    { text: `${glyph('statusPending')} Waiting for your answer`, tone: stateTone('attention') },
    ...stageTail,
  ];
  const elapsed =
    liveStatus !== null && liveStatus.stageStart > 0
      ? formatElapsedClock(Date.now() - liveStatus.stageStart - liveStatus.waitedMs)
      : '';
  const liveLead: ConversationRowSegment[] =
    liveStatus === null
      ? []
      : [
          { text: `${frame} `, tone: stateTone('running') },
          ...(operations.active?.apiRuntimeStatus?.phase === 'waiting-first-response'
            ? ([
                { text: 'Waiting for response', tone: 'textDim' },
              ] satisfies ConversationRowSegment[])
            : liveStatus.parts),
        ];

  const interrupted = lifecycle.status === 'interrupted';
  const interruptedLead: ConversationRowSegment[] = [
    { text: `${glyph('statusPending')} Interrupted`, tone: stateTone('attention') },
    { text: ' — finishing current step…', tone: 'textDim' },
  ];
  const runningBriefId = selectRunningBrief(tasks, lifecycle.phase).current?.id ?? null;
  const seat = phaseStage(lifecycle.phase);
  const resumingLead: ConversationRowSegment[] = [
    { text: `${frame} `, tone: stateTone('running') },
    { text: 'Resuming ', tone: 'text' },
    {
      text: runningBriefId ?? (seat === null ? 'the run' : `the ${seat}`),
      tone: seat === null ? 'text' : CREW_SEAT_ROLES[seat],
    },
  ];
  // A run that ended without finishing must not reach the stageLead fallback: the pip there is
  // `stageDone`, so the one line that survives at every width would report a completed-looking
  // stage for a run that stopped. `user_cancelled` is the only reason the engine names.
  const userCancelled = lifecycle.reason === WORKFLOW_CANCEL_REASON_USER;
  const stoppedGlyph = glyph(userCancelled ? 'statusCancelled' : 'statusFailed');
  const stoppedLead: ConversationRowSegment[] = [
    ...((userCancelled
      ? [{ text: `${stoppedGlyph} Stopped by you`, tone: stateTone('attention') }]
      : [
          { text: `${stoppedGlyph} `, tone: stateTone('failed') },
          { text: 'Build', tone: CREW_SEAT_ROLES.build },
          { text: ' failed', tone: stateTone('failed') },
        ]) satisfies ConversationRowSegment[]),
    ...stageTail,
  ];
  const recoveryStoppedLead: ConversationRowSegment[] = [
    { text: `${glyph('statusFailed')} Run stopped`, tone: stateTone('attention') },
  ];
  // The silence span and what the seat does through it come from the derivation the block's
  // freshness line reads, so the two surfaces state one fact in one wording; the block prints it
  // while it is on screen, this lead otherwise.
  const stall = lifecycle.status === 'running' && !buildBlockShown ? lifecycle.stall : null;
  const stalledLead: ConversationRowSegment[] =
    stall === null
      ? []
      : [
          {
            text: `${glyph('statusWarning')} ${silenceText(runnerSilenceMs(lifecycle, Date.now()) ?? 0, null)}`,
            tone: stateTone('attention'),
          },
        ];
  const stalledHint = stall === null ? null : silenceTail(operations.active, stall);

  // An actionable prompt takes precedence over the lifecycle state it interrupted.
  // The stop's own keys are the legend row's job: crowding them onto this row would cost the
  // state its words at 80 columns and print half a key at 60.
  // A lead's clock is kept apart from its words, so a byline too narrow for both cuts the words.
  const { lead, leadClock, hintText } = recoveryWaiting
    ? {
        lead: [
          {
            text: `${glyph('statusPending')} Choose how to continue`,
            tone: stateTone('attention'),
          },
        ] satisfies ConversationRowSegment[],
        hintText: null,
      }
    : stopped
      ? {
          lead: [{ text: `${glyph('statusPending')} `, tone: stopped.tone }, ...stopped.parts],
          leadClock: stopped.clock,
          hintText: null,
        }
      : recoveryStopped
        ? { lead: recoveryStoppedLead, hintText: null }
        : waiting || approval.status === 'pending'
          ? { lead: waitingLead, hintText: null }
          : lifecycle.status === 'cancelled'
            ? {
                lead: stoppedLead,
                hintText: null,
              }
            : interrupted
              ? { lead: interruptedLead, hintText: null }
              : resuming
                ? { lead: resumingLead, hintText: null }
                : stall !== null
                  ? {
                      lead: stalledLead,
                      hintText: stalledHint,
                    }
                  : liveStatus !== null
                    ? {
                        lead: liveLead,
                        leadClock: elapsed,
                        hintText: null,
                      }
                    : { lead: stageLead, hintText: null };

  const queuedCopy =
    lifecycle.queueDepth > 0 && (atRestStatus === null || atRestStatus === 'open')
      ? queueCopy({
          seat: messageSeat(lifecycle.phase, selectScheduledReview(operations)),
          taskId: runningBriefId,
          count: lifecycle.queueDepth,
        })
      : null;

  const atRestByline = givenByline !== undefined && stopped === null;
  const bylineLead = atRestByline
    ? ([
        { text: ' '.repeat(MARK_SLOT_CELLS), tone: 'textDim' },
        ...givenByline,
      ] satisfies ConversationRowSegment[])
    : lead;
  const bylineInput = {
    // Raw width in; the builder owns the framed text measure.
    cols: Math.max(1, width ?? cols),
    lead:
      atRestByline && queuedCopy !== null
        ? segmentsForRowText(
            bylineLead,
            truncateTerminalDisplayText(
              bylineLead.map((part) => part.text).join(''),
              getChromeContentWidth(width ?? cols) -
                getTerminalCellWidth(`${SOFT_SEP}${queuedCopy.shortByline}`),
            ),
          )
        : bylineLead,
    leadClock: atRestByline ? undefined : leadClock,
    hintText: atRestByline ? null : hintText,
    queuedText: queuedCopy?.byline ?? null,
    worktreeLabel: !atRestByline && worktreeName ? sanitizeTerminalDisplayText(worktreeName) : null,
  };
  let byline = buildInputFooterByline(bylineInput);
  if (queuedCopy !== null && !byline.some((part) => part.text === queuedCopy.byline)) {
    byline = buildInputFooterByline({ ...bylineInput, queuedText: queuedCopy.shortByline });
  }

  if (checkingStage !== null) {
    return (
      <Box width="100%" height={1} flexShrink={0}>
        <Text color={t.textDim} wrap="truncate-end">
          <Text color={t[stateTone('running')]}>{`${frame} `}</Text>
          {joinBylineParts([checkingStage, 'esc cancel'])}
        </Text>
      </Box>
    );
  }

  return (
    <Box width="100%" height={1} flexShrink={0}>
      <Text color={t.textDim} wrap="truncate-end">
        <TextSpans parts={byline} />
      </Text>
    </Box>
  );
}
