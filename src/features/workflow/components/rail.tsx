import { Box, Text } from 'ink';
import { formatStageLabel } from '../../../core/phase-display.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { glyph } from '../../../lib/glyphs.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { useTheme, type Theme } from '../../../components/theme.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import {
  chooseFormBVariant,
  getChromeContentWidth,
  getRailDriftPassed,
  getRailStages,
  isRailCurrent,
  measureFormB,
  railConnectorString,
  railFormBLabel,
  railIsHandoff,
  railStageRole,
  type RailForm,
  type RailRole,
  type RailStageState,
  type RailStageStatus,
} from '../layout/chrome-rows.js';
import { RAIL_FORM_C_CANCELLED_SUFFIX, resolveRailFraction } from '../layout/hit-test.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { TasksState } from '../../../stores/workflow/tasks.js';

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
  return glyph('stagePending');
}

function railFormCState(stages: RailStageState[]): RailStageState | undefined {
  const currentState = stages.find((state) => isRailCurrent(state.status));
  const fallback = stages.find((state) => state.status === 'pending') ?? stages[stages.length - 1];
  return currentState ?? fallback;
}

export function railFormCText(stages: RailStageState[], fraction: string): string {
  const state = railFormCState(stages);
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
  const dim = state.status === 'pending' || state.status === 'cancelled';
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
      <Text color={rc} bold={live} dimColor={dim}>
        {`${stageMarkerGlyph(state.status)} ${label}`}
      </Text>
    </Box>
  );
}

function RailFormB({ stages, contentWidth }: { stages: RailStageState[]; contentWidth: number }) {
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
  const state = railFormCState(stages);
  const live = state?.status === 'active';
  const rc = roleColor(railStageRole(state?.stage ?? 'spec'), t);
  return (
    <Box height={1} overflow="hidden">
      <Text color={rc} bold={live} dimColor={!live}>
        {railFormCText(stages, fraction)}
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
  tasks: TasksState;
  localCount: number;
  events: readonly EngineEvent[];
}): number {
  if (input.phase === 'complete') {
    return getTerminalCellWidth(
      railCompleteText({
        totalTasks: input.tasks.totalTasks,
        localCount: input.localCount,
        driftPassed: getRailDriftPassed(input.events),
      }),
    );
  }
  const stages = getRailStages(input.phase, { cancelled: input.cancelled });
  if (input.form === 'C') {
    const fraction = resolveRailFraction({
      phase: input.phase,
      currentTask: input.tasks.currentTask,
      totalTasks: input.tasks.totalTasks,
      cancelled: input.cancelled,
    });
    return getTerminalCellWidth(railFormCText(stages, fraction));
  }
  const { short } = chooseFormBVariant(stages, getChromeContentWidth(input.cols));
  return measureFormB(stages, { short });
}

export function Rail({ form }: { form?: RailForm | undefined }) {
  const [{ cols }, lifecycle, tasks, tokens, eventsState] = useStores(
    terminalSizeStore,
    lifecycleStore,
    tasksStore,
    tokensStore,
    eventsStore,
  );
  const phase = lifecycle.phase;
  const cancelled = lifecycle.cancelled;
  const resolved: RailForm = form ?? 'B';
  const contentWidth = getChromeContentWidth(cols);
  const stages = getRailStages(phase, { cancelled });
  const fraction = resolveRailFraction({
    phase,
    currentTask: tasks.currentTask,
    totalTasks: tasks.totalTasks,
    cancelled,
  });

  if (phase === 'complete') {
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
    return <RailFormC stages={stages} fraction={fraction} />;
  }

  return <RailFormB stages={stages} contentWidth={contentWidth} />;
}
