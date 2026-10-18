import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { formatStageLabel } from '../../../core/phase-display.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import { glyph } from '../../../lib/glyphs.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { TextSpans } from '../../../components/text-spans.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { ConversationRowSegment, ConversationRowTone } from '../conversation-rows/types.js';
import { colorForTone } from '../../../core/theme/tone-color.js';
import { lifecycleStore, type LifecycleState } from '../../../stores/workflow/lifecycle.js';
import { tasksStore, type TasksState } from '../../../stores/workflow/tasks.js';
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

const FAILED_REVIEW_STAGES = getRailStages('final-review', { halted: 'failed' });
const APPLY_HALT_STAGES = applyStopRailStages('failed');
const APPLY_RUNNING_STAGES = getRailStages('complete', { apply: 'active' });

// A run reaches `complete` whichever way its review went. One whose review failed stopped on that
// review — the log says so, or the halt it raised still waits — so the rail marks the review failed
// and never calls the run done. A halt at Apply follows a review that passed: the rail marks Apply,
// the step the run resumes at, as the rail of the same run at rest does. A run still running in
// `complete` resumed into Apply after a passed or accepted review, so Apply is the stage it is on.
function completePhaseStages(
  phase: Phase,
  status: LifecycleState['status'],
  events: readonly EngineEvent[],
  recoveryAt: StepRef | null,
): readonly RailStageState[] | null {
  if (phase !== 'complete') return null;
  if (recoveryAt?.kind === 'apply') return APPLY_HALT_STAGES;
  if (recoveryAt !== null) return FAILED_REVIEW_STAGES;
  if (status === 'running') return APPLY_RUNNING_STAGES;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'workflow_complete') {
      return event.review === 'failed' ? FAILED_REVIEW_STAGES : null;
    }
  }
  return null;
}

// The rail's actually-rendered width, so the header budgets the seat line against what the rail
// paints — not the full three-stage pipeline. A narrow terminal collapses to Form C, far shorter
// than the Form-B measure.
export function measureRailCells(input: {
  phase: Phase;
  status: LifecycleState['status'];
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
  const completeStages = completePhaseStages(
    input.phase,
    input.status,
    input.events,
    input.recoveryAt,
  );
  const stages = [
    ...(input.stages ??
      completeStages ??
      getRailStages(input.phase, { cancelled: input.cancelled })),
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
  const completeStages = completePhaseStages(
    phase,
    lifecycle.status,
    eventsState.events,
    recovery.at,
  );
  const stages = [
    ...(givenStages ??
      completeStages ??
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

  if (resolved === 'C') {
    return <RailFormC stages={stages} fraction={fraction} />;
  }

  return <RailFormB stages={stages} contentWidth={contentWidth} />;
}
