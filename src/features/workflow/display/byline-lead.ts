import { CHECKING_TOOLS_STAGE } from '../../../stores/navigation/preparation.js';
import {
  getActiveRailStage,
  railStageSeat,
  type RailStageState,
} from '../../../core/phases/rail.js';
import { stepWord } from './step-words.js';
import type { LiveStatus } from './live-activity.js';
import { seatRetrySentence, seatWaitSentence } from '../../../core/sessions/seat-wait-line.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { runnerSilenceMs, silenceTail, silenceText } from './build-progress/derive.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { formatElapsedClock } from '../../../utils/format/time.js';
import { selectRunningBrief, selectTaskListView } from '../../../core/run-view/briefs.js';
import type { RunView } from '../../../core/run-view/reduce.js';
import type { InputMode } from '../../../core/navigation/types.js';
import type { ActiveOperation } from '../../../stores/workflow/operations/state.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle/types.js';
import type { SlowProbeText } from '../../../hooks/use-slow-probe-text.js';
import type { StopByline } from '../stop/copy.js';
import { glyph } from '../../../lib/glyphs.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../../../engine/events/workflow-cancel.js';
import { formatStageLabel } from '../../../core/phases/labels.js';
import { fitCheckingRow, stageFractionText } from '../input-footer-byline.js';
import { stateTone } from '../../../core/theme/state-tone.js';

export interface BylineLeadInput {
  readonly lifecycle: LifecycleState;
  readonly runView: RunView;
  readonly activeOperation: ActiveOperation | null;
  readonly inputMode: InputMode;
  /** The recovery panel waits on the operator. */
  readonly recoveryOpen: boolean;
  /** The stop under way, when it has a lead of its own. */
  readonly stopped: StopByline | null;
  /** A question or an approval waits on the user's answer. */
  readonly waiting: boolean;
  readonly liveStatus: LiveStatus | null;
  readonly resuming: boolean;
  readonly runChecking: boolean;
  readonly slowProbe: SlowProbeText | null;
  /** The build block is on screen, and its freshness line states the seat's silence. */
  readonly buildBlockShown: boolean;
  readonly frame: string;
  readonly cols: number;
  readonly now: number;
}

interface BylineLead {
  readonly lead: readonly ConversationRowSegment[];
  /** A lead's clock is kept apart from its words, so a byline too narrow for both cuts the words. */
  readonly leadClock?: string | undefined;
  readonly hintText: string | null;
}

export function deriveBylineLead(input: BylineLeadInput): BylineLead {
  const { lifecycle, runView, activeOperation, stopped, liveStatus, frame, slowProbe, now } = input;
  const taskListView = selectTaskListView(runView.briefs);
  // With REVIEW None the final-review phase of a workspace run only rechecks the merged result for Apply.
  const activeStage: RailStageState | null =
    runView.phase === 'final-review' && runView.afterLastBrief.kind === 'apply'
      ? { stage: 'apply', status: 'active' }
      : getActiveRailStage(runView.phase);
  const stageText = activeStage ? formatStageLabel(activeStage.stage) : '';
  const fractionText = activeStage?.stage === 'build' ? stageFractionText(taskListView) : '';
  const recoveryWaiting = runView.halt !== null && input.inputMode === 'question';
  // A halt the panel has not opened on yet is a run still going to it, not a stopped run.
  const recoveryStopped = input.recoveryOpen && !recoveryWaiting;

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
      ? formatElapsedClock(now - liveStatus.stageStart - liveStatus.waitedMs)
      : '';
  const liveLead: ConversationRowSegment[] =
    liveStatus === null
      ? []
      : [
          { text: `${frame} `, tone: stateTone('running') },
          ...(activeOperation?.apiRuntimeStatus?.phase === 'waiting-first-response'
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
  const runningBriefId = selectRunningBrief(runView.briefs, runView.phase).current?.id ?? null;
  const resumingLead: ConversationRowSegment[] = [
    { text: `${frame} `, tone: stateTone('running') },
    { text: 'Resuming ', tone: 'text' },
    {
      text:
        runningBriefId ??
        (activeStage === null
          ? 'the run'
          : activeStage.stage === 'apply'
            ? stepWord({ kind: 'apply' })
            : `the ${activeStage.stage}`),
      tone: stageSeat === null ? 'text' : CREW_SEAT_ROLES[stageSeat],
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
  const stall = lifecycle.status === 'running' && !input.buildBlockShown ? lifecycle.stall : null;
  const stalledLead: ConversationRowSegment[] =
    stall === null
      ? []
      : [
          {
            text: `${glyph('statusWarning')} ${silenceText(runnerSilenceMs(lifecycle, now) ?? 0, null)}`,
            tone: stateTone('attention'),
          },
        ];
  const stalledHint = stall === null ? null : silenceTail(activeOperation, stall);
  // The legend row already offers the run's stop, so the row names only the check and its wait.
  const runCheckingLead: ConversationRowSegment[] =
    slowProbe === null
      ? []
      : [
          { text: `${frame} `, tone: stateTone('running') },
          {
            text: fitCheckingRow({
              frame,
              stage: CHECKING_TOOLS_STAGE,
              slowProbe,
              cancellable: false,
              width: getChromeContentWidth(input.cols),
            }),
            tone: 'textDim',
          },
        ];
  const wait = runView.seatWait;
  const seatWait = wait?.live ? seatWaitSentence(wait.tool, wait.wait.resetAt, now) : null;
  const seatWaitLead: ConversationRowSegment[] =
    seatWait === null
      ? []
      : [
          {
            text: `${glyph('statusPending')} ${seatWait}`,
            tone: stateTone('attention'),
          },
        ];
  const retrySentence = lifecycle.retry === null ? null : seatRetrySentence(lifecycle.retry);
  const retryLead: ConversationRowSegment[] =
    retrySentence === null
      ? []
      : [
          { text: `${frame} `, tone: stateTone('running') },
          { text: retrySentence, tone: 'textDim' },
        ];

  // An actionable prompt takes precedence over the lifecycle state it interrupted.
  // The stop's own keys are the legend row's job: crowding them onto this row would cost the
  // state its words at 80 columns and print half a key at 60.
  return recoveryWaiting
    ? {
        lead: [
          {
            text: `${glyph('statusPending')} Choose how to continue`,
            tone: stateTone('attention'),
          },
        ],
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
        : input.waiting
          ? { lead: waitingLead, hintText: null }
          : lifecycle.status === 'cancelled'
            ? {
                lead: stoppedLead,
                hintText: null,
              }
            : interrupted
              ? { lead: interruptedLead, hintText: null }
              : seatWait !== null
                ? { lead: seatWaitLead, hintText: null }
                : retrySentence !== null
                  ? { lead: retryLead, hintText: null }
                  : input.runChecking
                    ? { lead: runCheckingLead, hintText: null }
                    : input.resuming
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
}
