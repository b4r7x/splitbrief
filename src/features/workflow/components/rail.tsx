import { Box, Text } from 'ink';
import { formatStageLabel } from '../../../core/phase-display.js';
import type { Phase, WorkflowMode } from '../../../core/schemas/enums.js';
import { glyph } from '../../../lib/glyphs.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { useTheme, type Theme } from '../../../components/theme.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import {
  getRailStages,
  railIsHandoff,
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
import type { TasksState } from '../../../stores/workflow/tasks.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { deriveWorkflowDisplay } from '../display/workflow-status.js';

interface RailDoneSummary {
  totalTasks: number;
  localCount: number;
  driftPassed: boolean | undefined;
}

function roleColor(role: RailRole, t: Theme): string {
  if (role === 'implementer') return t.implementer;
  if (role === 'validator') return t.validator;
  return t.planner;
}

function stageMarkerGlyph(status: RailStageStatus): string {
  if (status === 'done') return glyph('stageDone');
  if (status === 'active') return glyph('stageActive');
  if (status === 'cancelled') return glyph('statusCancelled');
  if (status === 'failed') return glyph('statusFailed');
  return glyph('stagePending');
}

function haltColor(status: RailStageStatus, t: Theme): string | null {
  if (status === 'cancelled') return t.warning;
  if (status === 'failed') return t.error;
  return null;
}

function railFormCState(
  stages: RailStageState[],
  mode: WorkflowMode = 'standard',
): RailStageState | undefined {
  return selectRailStage(stages, mode)?.state;
}

export function railFormCText(input: {
  stages: RailStageState[];
  fraction: string;
  mode?: WorkflowMode | undefined;
}): string {
  const { stages, fraction, mode = 'standard' } = input;
  const state = railFormCState(stages, mode);
  const status = state?.status ?? 'pending';
  const stage = state?.stage ?? 'spec';
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
  // Three-tier weight: pending stays faint, done steps up to full hue (it happened), active gets
  // bold plus the ◉ marker so the eye lands on exactly one node without adding any characters
  // (the marker+label text keeps its cell count, so the hit-test geometry never moves).
  const halt = haltColor(state.status, t);
  const dim = state.status === 'pending' || halt !== null;
  const rc = roleColor(railStageRole(state.stage), t);
  const label = railFormBLabel(state, { short });
  const left = index > 0 ? stages[index - 1] : undefined;
  const connector =
    left !== undefined
      ? {
          text: railConnectorString({ handoff: railIsHandoff(left.stage, state.stage) }),
          color: left.status === 'done' ? roleColor(railStageRole(left.stage), t) : t.textDim,
        }
      : undefined;
  return (
    <Box>
      {connector !== undefined && <Text color={connector.color}>{connector.text}</Text>}
      {halt === null ? (
        <Text color={rc} bold={live} dimColor={dim}>
          {`${stageMarkerGlyph(state.status)} ${label}`}
        </Text>
      ) : (
        <>
          <Text color={halt}>{`${stageMarkerGlyph(state.status)} `}</Text>
          <Text color={rc} dimColor>
            {label}
          </Text>
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

function RailFormC({
  stages,
  fraction,
  mode,
}: {
  stages: RailStageState[];
  fraction: string;
  mode: WorkflowMode;
}) {
  const t = useTheme();
  const state = railFormCState(stages, mode);
  const live = state?.status === 'active';
  const rc = roleColor(railStageRole(state?.stage ?? 'spec'), t);
  return (
    <Box height={1} overflow="hidden">
      <Text color={rc} bold={live} dimColor={!live}>
        {railFormCText({ stages, fraction, mode })}
      </Text>
    </Box>
  );
}

function railCompleteText(summary: RailDoneSummary): string {
  const parts = ['done'];
  if (summary.totalTasks > 0) parts.push(`${summary.localCount}/${summary.totalTasks} local`);
  parts.push(summary.driftPassed === false ? 'drift found' : 'no drift');
  return `${glyph('statusDone')} ${parts.join(SOFT_SEP)}`;
}

function RailComplete({ summary }: { summary: RailDoneSummary }) {
  const t = useTheme();
  return (
    <Box height={1} overflow="hidden">
      <Text color={t.success}>{railCompleteText(summary)}</Text>
    </Box>
  );
}

// The rail's actually-rendered width, so the header budgets the runner/clock tail against what the
// rail paints — not the full five-stage pipeline. `complete` collapses to a short done line and a
// narrow terminal collapses to Form C, both far shorter than the Form-B measure.
export function measureRailCells(input: {
  phase: Phase;
  cancelled: boolean;
  form: RailForm;
  cols: number;
  mode?: WorkflowMode | undefined;
  tasks: TasksState;
  localCount: number;
  events: readonly EngineEvent[];
  /** Stages the caller already knows; a run at rest wears the mark its own status earned. */
  stages?: readonly RailStageState[] | undefined;
}): number {
  const mode = input.mode ?? 'standard';
  if (input.stages === undefined && input.phase === 'complete') {
    return getTerminalCellWidth(
      railCompleteText({
        totalTasks: input.tasks.totalTasks,
        localCount: input.localCount,
        driftPassed: getRailDriftPassed(input.events),
      }),
    );
  }
  const stages = [
    ...(input.stages ?? getRailStages(input.phase, { cancelled: input.cancelled, mode })),
  ];
  if (input.form === 'C') {
    const fraction = resolveRailFraction({
      phase: input.phase,
      currentTask: input.tasks.currentTask,
      totalTasks: input.tasks.totalTasks,
      cancelled: input.cancelled,
      mode,
    });
    return getTerminalCellWidth(railFormCText({ stages, fraction, mode }));
  }
  const { short } = chooseFormBVariant(stages, getChromeContentWidth(input.cols));
  return measureFormB(stages, { short });
}

export function Rail({
  form,
  mode: givenMode,
  stages: givenStages,
}: {
  form?: RailForm | undefined;
  mode?: WorkflowMode | undefined;
  /** A run at rest paints the stages its record names, not the ones a live phase implies. */
  stages?: readonly RailStageState[] | undefined;
}) {
  const [{ cols }, lifecycle, tasks, tokens, eventsState, controls, approval, recovery] = useStores(
    terminalSizeStore,
    lifecycleStore,
    tasksStore,
    tokensStore,
    eventsStore,
    controlsStore,
    approvalPromptStore,
    recoveryNoticeStore,
  );
  const phase = lifecycle.phase;
  const cancelled = lifecycle.cancelled;
  const resolved: RailForm = form ?? 'B';
  const mode = givenMode ?? 'standard';
  const contentWidth = getChromeContentWidth(cols);
  const display = deriveWorkflowDisplay({
    status: lifecycle.status,
    cancelled,
    pendingQuestion: controls.inputMode !== 'normal',
    pendingRecovery: recovery.issue !== null,
    pendingApproval: approval.status === 'pending',
  });
  const stages = [
    ...(givenStages ??
      getRailStages(phase, {
        cancelled,
        mode,
        ...(display.halted === undefined ? {} : { halted: display.halted }),
      })),
  ];
  const fraction = resolveRailFraction({
    phase,
    currentTask: tasks.currentTask,
    totalTasks: tasks.totalTasks,
    cancelled,
    mode,
  });

  if (givenStages === undefined && phase === 'complete') {
    return (
      <RailComplete
        summary={{
          totalTasks: tasks.totalTasks,
          localCount: tokens.localCount,
          driftPassed: getRailDriftPassed(eventsState.events),
        }}
      />
    );
  }
  if (resolved === 'C') {
    return <RailFormC stages={stages} fraction={fraction} mode={mode} />;
  }

  return <RailFormB stages={stages} contentWidth={contentWidth} />;
}
