import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { formatStageLabel } from '../../../core/phase-display.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { glyph } from '../../../lib/glyphs.js';
import { SOFT_SEP } from '../../../core/separators.js';
import type { Theme } from '../../../core/theme/palette.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import {
  getRailStages,
  railStageRole,
  selectRailStage,
  type RailRole,
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
import { RAIL_FORM_C_CANCELLED_SUFFIX, resolveRailFraction } from '../layout/hit-test.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { selectTaskListView, type TasksState } from '../../../stores/workflow/tasks.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { deriveWorkflowDisplay } from '../display/workflow-status.js';

interface RailDoneSummary {
  passed: number;
  total: number;
  driftPassed: boolean | undefined;
}

function roleColor(role: RailRole, t: Theme): string | undefined {
  if (role === 'implementer') return t.implementer;
  if (role === 'validator') return t.validator;
  return t.planner;
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

function haltColor(status: RailStageStatus, t: Theme): string | undefined | null {
  if (status === 'cancelled') return t.warning;
  if (status === 'failed') return t.error;
  return null;
}

export function railFormCText(input: { stages: RailStageState[]; fraction: string }): string {
  const { stages, fraction } = input;
  const state = selectRailStage(stages)?.state;
  const status = state?.status ?? 'pending';
  const stage = state?.stage ?? 'plan';
  const text = `${stageMarkerGlyph(status)} ${formatStageLabel(stage)}`;
  if (status === 'cancelled') return `${text}${RAIL_FORM_C_CANCELLED_SUFFIX}`;
  if (status === 'active' && fraction !== '') return `${text}  task ${fraction}`;
  return text;
}

function RailFormBNode({
  state,
  index,
  stages,
  short,
}: {
  state: RailStageState;
  index: number;
  stages: RailStageState[];
  short: boolean;
}) {
  const t = useTheme();
  const live = state.status === 'active';
  // The stage the run is on is the one bright, bold node; the stages behind it and ahead of it are
  // secondary, told apart by the filled mark and the ring (the marker+label text keeps its cell count,
  // so the hit-test geometry never moves).
  const halt = haltColor(state.status, t);
  const rc = roleColor(railStageRole(state.stage), t);
  const label = railFormBLabel(state, { short });
  const left = index > 0 ? stages[index - 1] : undefined;
  const connector =
    left !== undefined
      ? {
          text: railConnectorString(),
          color: left.status === 'done' ? roleColor(railStageRole(left.stage), t) : t.textDim,
        }
      : undefined;
  return (
    <Box>
      {connector !== undefined && <Text color={connector.color}>{connector.text}</Text>}
      {halt === null ? (
        <Text color={live ? rc : t.textDim} bold={live}>
          {`${stageMarkerGlyph(state.status)} ${label}`}
        </Text>
      ) : (
        <>
          <Text color={halt}>{`${stageMarkerGlyph(state.status)} `}</Text>
          <Text color={t.textDim}>{label}</Text>
        </>
      )}
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
        <RailFormBNode
          key={state.stage}
          state={state}
          index={index}
          stages={stages}
          short={short}
        />
      ))}
    </Box>
  );
}

function RailFormC({ stages, fraction }: { stages: RailStageState[]; fraction: string }) {
  const t = useTheme();
  const state = selectRailStage(stages)?.state;
  const live = state?.status === 'active';
  const rc = roleColor(railStageRole(state?.stage ?? 'plan'), t);
  return (
    <Box height={1} overflow="hidden">
      <Text color={live ? rc : t.textDim} bold={live}>
        {railFormCText({ stages, fraction })}
      </Text>
    </Box>
  );
}

// The fraction the build block states, out of the plan as it stands — fix tasks a review appended
// included — so a brief is counted once however many completions the log carried for it.
function railCompleteText(summary: RailDoneSummary): string {
  const parts = ['done'];
  if (summary.total > 0) parts.push(`${summary.passed}/${summary.total} briefs passed`);
  if (summary.driftPassed === undefined) parts.push('drift not run');
  else parts.push(summary.driftPassed ? 'no drift' : 'drift found');
  return `${glyph('stageDone')} ${parts.join(SOFT_SEP)}`;
}

function RailComplete({ summary }: { summary: RailDoneSummary }) {
  const t = useTheme();
  return (
    <Box height={1} overflow="hidden">
      <Text color={t.success}>{railCompleteText(summary)}</Text>
    </Box>
  );
}

function railDoneSummary(tasks: TasksState, events: readonly EngineEvent[]): RailDoneSummary {
  const view = selectTaskListView(tasks);
  return { passed: view.passed, total: view.total, driftPassed: getRailDriftPassed(events) };
}

// A run reaches `complete` whichever way its review went. One whose review failed stopped on that
// review — the log says so, or the halt it raised still waits — so the rail marks the review failed
// and never calls the run done.
function reviewFailed(
  phase: Phase,
  events: readonly EngineEvent[],
  recoveryPending: boolean,
): boolean {
  if (phase !== 'complete') return false;
  if (recoveryPending) return true;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'workflow_complete') return event.review === 'failed';
  }
  return false;
}

const FAILED_REVIEW_STAGES = getRailStages('final-review', { halted: 'failed' });

// The rail's actually-rendered width, so the header budgets the runner/clock tail against what the
// rail paints — not the full three-stage pipeline. `complete` collapses to a short done line and a
// narrow terminal collapses to Form C, both far shorter than the Form-B measure.
export function measureRailCells(input: {
  phase: Phase;
  cancelled: boolean;
  form: RailForm;
  cols: number;
  tasks: TasksState;
  events: readonly EngineEvent[];
  recoveryPending: boolean;
  /** Stages the caller already knows; a run at rest wears the mark its own status earned. */
  stages?: readonly RailStageState[] | undefined;
}): number {
  const failedReview = reviewFailed(input.phase, input.events, input.recoveryPending);
  if (input.stages === undefined && input.phase === 'complete' && !failedReview) {
    return getTerminalCellWidth(railCompleteText(railDoneSummary(input.tasks, input.events)));
  }
  const stages = [
    ...(input.stages ??
      (failedReview
        ? FAILED_REVIEW_STAGES
        : getRailStages(input.phase, { cancelled: input.cancelled }))),
  ];
  if (input.form === 'C') {
    const fraction = resolveRailFraction({
      phase: input.phase,
      currentTask: input.tasks.currentTask,
      totalTasks: input.tasks.totalTasks,
      cancelled: input.cancelled,
    });
    return getTerminalCellWidth(railFormCText({ stages, fraction }));
  }
  const { short } = chooseFormBVariant(stages, getChromeContentWidth(input.cols));
  return measureFormB(stages, { short });
}

export function Rail({
  form,
  stages: givenStages,
}: {
  form?: RailForm | undefined;
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
  const failedReview = reviewFailed(phase, eventsState.events, recovery.issue !== null);
  const stages = [
    ...(givenStages ??
      (failedReview
        ? FAILED_REVIEW_STAGES
        : getRailStages(phase, {
            cancelled,
            ...(display.halted === undefined ? {} : { halted: display.halted }),
          }))),
  ];
  const fraction = resolveRailFraction({
    phase,
    currentTask: tasks.currentTask,
    totalTasks: tasks.totalTasks,
    cancelled,
  });

  if (givenStages === undefined && phase === 'complete' && !failedReview) {
    return <RailComplete summary={railDoneSummary(tasks, eventsState.events)} />;
  }
  if (resolved === 'C') {
    return <RailFormC stages={stages} fraction={fraction} />;
  }

  return <RailFormB stages={stages} contentWidth={contentWidth} />;
}
