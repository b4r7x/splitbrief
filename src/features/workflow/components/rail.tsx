import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { formatStageLabel } from '../../../core/phase-display.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import { glyph } from '../../../lib/glyphs.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { TextSpans } from '../../../components/text-spans.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { ConversationRowSegment, ConversationRowTone } from '../conversation-rows/types.js';
import { colorForTone } from '../../../core/theme/tone-color.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore, selectTaskListView, type TasksState } from '../../../stores/workflow/tasks.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import {
  applyStopRailStages,
  getRailStages,
  railStageSeat,
  selectRailStage,
  type RailStageState,
  type RailStageStatus,
} from '../../../core/rail-stages.js';
import {
  chooseFormBVariant,
  getChromeContentWidth,
  getRailDriftPassed,
  measureFormB,
  railConnectorString,
  railFormBLabel,
  type RailForm,
} from '../layout/chrome-rows.js';
import {
  RAIL_FORM_C_CANCELLED_SUFFIX,
  railFormCFractionSpans,
  resolveRailFraction,
} from '../layout/hit-test.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { deriveWorkflowDisplay } from '../display/workflow-status.js';
import { passedFractionSpans } from '../display/build-progress.js';

interface RailDoneSummary {
  passed: number;
  total: number;
  driftPassed: boolean | undefined;
}

// Done and active share the filled mark, so the three marks a live rail paints are one family of
// one width on every font: weight and brightness tell the stage the run is on from the ones behind
// it, and the ring tells the ones ahead.
function stageMarkerGlyph(status: RailStageStatus): string {
  if (status === 'done' || status === 'active') return glyph('stageDone');
  if (status === 'cancelled') return glyph('statusCancelled');
  if (status === 'failed') return glyph('statusFailed');
  return glyph('stagePending');
}

function stageMarkerTone(state: RailStageState): ConversationRowTone {
  switch (state.status) {
    case 'done':
      return stateTone('passed');
    case 'active':
      return stageLabelTone(state);
    case 'pending':
      return stateTone('pending');
    case 'cancelled':
      return stateTone('attention');
    case 'failed':
      return stateTone('failed');
    default:
      return assertNever(state.status);
  }
}

function stageLabelTone(state: RailStageState): ConversationRowTone {
  if (state.status === 'pending') return stateTone('pending');
  const seat = railStageSeat(state.stage);
  return seat === null ? 'text' : CREW_SEAT_ROLES[seat];
}

export function railFormCText(input: { stages: RailStageState[]; fraction: string }): string {
  return railFormCSpans(input)
    .map((span) => span.text)
    .join('');
}

function railFormCSpans(input: {
  stages: RailStageState[];
  fraction: string;
}): ConversationRowSegment[] {
  const { stages, fraction } = input;
  const state = selectRailStage(stages)?.state ?? { stage: 'plan', status: 'pending' };
  const { status, stage } = state;
  const spans: ConversationRowSegment[] = [
    {
      text: `${stageMarkerGlyph(status)} `,
      tone: stageMarkerTone(state),
      bold: status === 'active',
    },
    { text: formatStageLabel(stage), tone: stageLabelTone(state), bold: status === 'active' },
  ];
  if (status === 'cancelled')
    spans.push({ text: RAIL_FORM_C_CANCELLED_SUFFIX, tone: stateTone('attention') });
  if (status === 'active') spans.push(...railFormCFractionSpans(fraction));
  return spans;
}

function RailFormBNode({
  state,
  index,
  short,
}: {
  state: RailStageState;
  index: number;
  short: boolean;
}) {
  const t = useTheme();
  const live = state.status === 'active';
  const label = railFormBLabel(state, { short });
  return (
    <Box>
      {index > 0 && <Text color={t.border}>{railConnectorString()}</Text>}
      <Text color={colorForTone(stageMarkerTone(state), t)} bold={live}>
        {`${stageMarkerGlyph(state.status)} `}
      </Text>
      <Text color={colorForTone(stageLabelTone(state), t)} bold={live}>
        {label}
      </Text>
    </Box>
  );
}

export function RailFormB({
  stages,
  contentWidth,
}: {
  stages: RailStageState[];
  contentWidth: number;
}) {
  const { short } = chooseFormBVariant(stages, contentWidth);
  return (
    <Box height={1} overflow="hidden">
      {stages.map((state, index) => (
        <RailFormBNode key={state.stage} state={state} index={index} short={short} />
      ))}
    </Box>
  );
}

function RailFormC({ stages, fraction }: { stages: RailStageState[]; fraction: string }) {
  return (
    <Box height={1} overflow="hidden">
      <Text>
        <TextSpans parts={railFormCSpans({ stages, fraction })} />
      </Text>
    </Box>
  );
}

// The fraction the build block states, out of the plan as it stands — fix tasks a review appended
// included — so a brief is counted once however many completions the log carried for it.
function railCompleteText(summary: RailDoneSummary): string {
  return railCompleteSpans(summary)
    .map((span) => span.text)
    .join('');
}

function railCompleteSpans(summary: RailDoneSummary): ConversationRowSegment[] {
  const spans: ConversationRowSegment[] = [
    { text: `${glyph('stageDone')} done`, tone: stateTone('passed') },
  ];
  if (summary.total > 0)
    spans.push(
      { text: SOFT_SEP, tone: 'textDim' },
      ...passedFractionSpans(`${summary.passed}/${summary.total} briefs`),
    );
  spans.push({ text: SOFT_SEP, tone: 'textDim' });
  spans.push({
    text:
      summary.driftPassed === undefined
        ? 'drift not run'
        : summary.driftPassed
          ? 'no drift'
          : 'drift found',
    tone:
      summary.driftPassed === undefined
        ? stateTone('pending')
        : summary.driftPassed
          ? stateTone('passed')
          : stateTone('attention'),
  });
  return spans;
}

function RailComplete({ summary }: { summary: RailDoneSummary }) {
  return (
    <Box height={1} overflow="hidden">
      <Text>
        <TextSpans parts={railCompleteSpans(summary)} />
      </Text>
    </Box>
  );
}

function railDoneSummary(tasks: TasksState, events: readonly EngineEvent[]): RailDoneSummary {
  const view = selectTaskListView(tasks);
  return { passed: view.passed, total: view.total, driftPassed: getRailDriftPassed(events) };
}

const FAILED_REVIEW_STAGES = getRailStages('final-review', { halted: 'failed' });
const APPLY_HALT_STAGES = applyStopRailStages('failed');

// A run reaches `complete` whichever way its review went. One whose review failed stopped on that
// review — the log says so, or the halt it raised still waits — so the rail marks the review failed
// and never calls the run done. A halt at Apply follows a review that passed: the rail marks Apply,
// the step the run resumes at, as the rail of the same run at rest does.
function haltedCompleteStages(
  phase: Phase,
  events: readonly EngineEvent[],
  recoveryAt: StepRef | null,
): readonly RailStageState[] | null {
  if (phase !== 'complete') return null;
  if (recoveryAt?.kind === 'apply') return APPLY_HALT_STAGES;
  if (recoveryAt !== null) return FAILED_REVIEW_STAGES;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'workflow_complete') {
      return event.review === 'failed' ? FAILED_REVIEW_STAGES : null;
    }
  }
  return null;
}

// The rail's actually-rendered width, so the header budgets the seat line against what the rail
// paints — not the full three-stage pipeline. `complete` collapses to a short done line and a
// narrow terminal collapses to Form C, both far shorter than the Form-B measure.
export function measureRailCells(input: {
  phase: Phase;
  cancelled: boolean;
  form: RailForm;
  cols: number;
  tasks: TasksState;
  events: readonly EngineEvent[];
  /** The step an open halt resumes at; null while no halt waits. */
  recoveryAt: StepRef | null;
  buildBlockShown: boolean;
  /** Stages the caller already knows; a run at rest wears the mark its own status earned. */
  stages?: readonly RailStageState[] | undefined;
}): number {
  const halted = haltedCompleteStages(input.phase, input.events, input.recoveryAt);
  if (input.stages === undefined && input.phase === 'complete' && halted === null) {
    return getTerminalCellWidth(railCompleteText(railDoneSummary(input.tasks, input.events)));
  }
  const stages = [
    ...(input.stages ?? halted ?? getRailStages(input.phase, { cancelled: input.cancelled })),
  ];
  if (input.form === 'C') {
    const fraction = resolveRailFraction({
      phase: input.phase,
      tasks: input.tasks,
      cancelled: input.cancelled,
      buildBlockShown: input.buildBlockShown,
    });
    return getTerminalCellWidth(railFormCText({ stages, fraction }));
  }
  const { short } = chooseFormBVariant(stages, getChromeContentWidth(input.cols));
  return measureFormB(stages, { short });
}

export function Rail({
  form,
  stages: givenStages,
  buildBlockShown = false,
}: {
  form?: RailForm | undefined;
  buildBlockShown?: boolean | undefined;
  /** A run at rest paints the stages its record names, not the ones a live phase implies. */
  stages?: readonly RailStageState[] | undefined;
}) {
  const [{ cols }, lifecycle, tasks, eventsState, controls, approval, recovery] = useStores(
    terminalSizeStore,
    lifecycleStore,
    tasksStore,
    eventsStore,
    controlsStore,
    approvalPromptStore,
    recoveryNoticeStore,
  );
  const phase = lifecycle.phase;
  const cancelled = lifecycle.cancelled;
  const resolved: RailForm = form ?? 'B';
  const contentWidth = getChromeContentWidth(cols);
  const display = deriveWorkflowDisplay({
    status: lifecycle.status,
    cancelled,
    pendingQuestion: controls.inputMode !== 'normal',
    pendingRecovery: recovery.issue !== null,
    pendingApproval: approval.status === 'pending',
  });
  const halted = haltedCompleteStages(phase, eventsState.events, recovery.at);
  const stages = [
    ...(givenStages ??
      halted ??
      getRailStages(phase, {
        cancelled,
        ...(display.halted === undefined ? {} : { halted: display.halted }),
      })),
  ];
  const fraction = resolveRailFraction({
    phase,
    tasks,
    cancelled,
    buildBlockShown,
  });

  if (givenStages === undefined && phase === 'complete' && halted === null) {
    return <RailComplete summary={railDoneSummary(tasks, eventsState.events)} />;
  }
  if (resolved === 'C') {
    return <RailFormC stages={stages} fraction={fraction} />;
  }

  return <RailFormB stages={stages} contentWidth={contentWidth} />;
}
