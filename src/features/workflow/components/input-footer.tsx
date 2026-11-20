import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { panelModel, preparationHint } from '../../../components/preparation-problem.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';
import { sessionSelectStore } from '../../../stores/navigation/session-select.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { useStores } from '../../../stores/use-many.js';
import { configStore } from '../../../stores/project/config.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { preparationStore, selectCheckingStage } from '../../../stores/navigation/preparation.js';
import { deriveLiveStatus } from '../display/live-activity.js';
import { deriveBylineLead } from '../display/byline-lead.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { collapsedReviewSeat } from '../../../core/crew/seats.js';
import { TextSpans } from '../../../components/text-spans.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { operationsStore, selectRunningSuite } from '../../../stores/workflow/operations/state.js';
import { useStopByline } from '../stop/use-byline.js';
import { useSpinnerFrame } from '../../../hooks/use-spinner-frame.js';
import { useSlowProbeText } from '../../../hooks/use-slow-probe-text.js';
import { fitCheckingRow, fitInputFooterByline } from '../input-footer-byline.js';
import { formatSeatIdentity, isReviewNone } from '../../../core/crew/identity.js';
import { useCrewDisplayNames } from '../../../hooks/use-crew-display-names.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { runQueueCopy } from '../queue-copy.js';
import { approvalPromptStore } from '../../../stores/prompts/approval.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
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
  const [lifecycle, { cols }, operations, controls, approval, recovery, runView] = useStores(
    lifecycleStore,
    terminalSizeStore,
    operationsStore,
    controlsStore,
    approvalPromptStore,
    recoveryNoticeStore,
    runViewStore,
  );
  const worktreeName = routerStore.use((s) =>
    s.screen === 'workflow' && s.execution.kind === 'local'
      ? s.execution.prepared.runtime.worktreeName
      : undefined,
  );
  const atRestStatus = routerStore.use((s) =>
    s.screen === 'workflow' && s.execution.kind === 'at-rest' ? s.run.status.kind : null,
  );
  const stopByline = useStopByline();
  // A seat change has no lead of its own: the run it waits beside keeps the byline.
  const stopped = stopByline !== null && stopByline.parts.length > 0 ? stopByline : null;
  const config = configStore.useConfig();
  const displayNames = useCrewDisplayNames(config);
  const reviewer = collapsedReviewSeat(config);
  const reviewerSeat = isReviewNone(reviewer)
    ? reviewer.mark
    : reviewer
      ? formatSeatIdentity({
          seat: reviewer,
          displayName: displayNames.review ?? displayNames.plan,
        })
      : '';

  // Re-entering a run at rest checks its tools first. That wait belongs on this row — the run
  // itself stays on screen, the composer beside it stays live, and the word is the request's own.
  const checkingStage = preparationStore.use(selectCheckingStage);

  const display = deriveWorkflowDisplay({
    status: lifecycle.status,
    cancelled: lifecycle.cancelled,
    pendingQuestion: waiting || controls.inputMode !== 'normal',
    pendingRecovery: runView.halt !== null,
    pendingApproval: approval.status === 'pending',
  });
  const now = Date.now();
  const liveStatus =
    waiting || !display.animate
      ? null
      : deriveLiveStatus({
          phase: runView.phase,
          status: lifecycle.status,
          cancelled: lifecycle.cancelled,
          startedAt: lifecycle.startedAt,
          phaseFirstSeen: runView.phaseFirstSeen,
          waitedMs: lifecycle.waitedMs ?? {},
          resumedAt: lifecycle.resumedAt ?? null,
          reviewerLabel: reviewerSeat === '' ? null : reviewerSeat,
          reviewNone: runView.reviewNone,
          plannerCall: lifecycle.plannerCall ?? null,
          plannerCallStartedTs: lifecycle.plannerCallStartedTs ?? null,
          suiteStage: selectRunningSuite(operations),
          activeOperation: operations.active,
          briefClock: lifecycle.briefClock ?? null,
          now,
        });
  // A run on screen that is paused with no stop of its own and no record byline has been
  // continued: the engine is reaping, restoring and re-entering before its first event.
  const resuming = lifecycle.status === 'paused' && stopped === null && givenByline === undefined;
  const slowProbe = useSlowProbeText();
  // A live run checks its API seat at its start and before each brief, after preparation settled.
  const runChecking =
    slowProbe !== null && givenByline === undefined && lifecycle.status !== 'complete';
  const { frame } = useSpinnerFrame(
    display.animate || checkingStage !== null || resuming || runChecking,
  );

  const { lead, leadClock, hintText } = deriveBylineLead({
    lifecycle,
    runView,
    activeOperation: operations.active,
    inputMode: controls.inputMode,
    recoveryOpen: recovery.open,
    stopped,
    waiting: waiting || approval.status === 'pending',
    liveStatus,
    resuming,
    runChecking,
    slowProbe,
    buildBlockShown,
    frame,
    cols: Math.max(1, width ?? cols),
    now,
  });

  const problem = panelModel(sessionSelectStore.use((state) => state.preparation));
  const byline = fitInputFooterByline({
    cols: width ?? cols,
    lead,
    leadClock,
    hintText,
    recordByline: problem
      ? [
          {
            text: preparationHint(problem, getChromeContentWidth(width ?? cols) - MARK_SLOT_CELLS),
            tone: 'textDim',
          },
        ]
      : stopped === null
        ? givenByline
        : undefined,
    queued:
      lifecycle.queueDepth > 0 && (atRestStatus === null || atRestStatus === 'open')
        ? runQueueCopy(runView, operations, lifecycle.queueDepth)
        : null,
    worktreeName,
  });

  if (checkingStage !== null) {
    return (
      <Box width="100%" height={1} flexShrink={0}>
        <Text color={t.textDim} wrap="truncate-end">
          <Text color={t[stateTone('running')]}>{`${frame} `}</Text>
          {fitCheckingRow({
            frame,
            stage: checkingStage,
            slowProbe,
            cancellable: true,
            width: getChromeContentWidth(Math.max(1, width ?? cols)),
          })}
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
