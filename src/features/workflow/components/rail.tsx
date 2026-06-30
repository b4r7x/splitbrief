import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { Phase } from '../../../core/schemas/enums.js';
import { glyph } from '../../../lib/glyphs.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { useTheme, type Theme } from '../../../components/theme.js';
import { Spinner } from './spinner.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../utils/display-text.js';
import { countNoun } from '../../../utils/pluralize.js';
import { assertNever } from '../../../utils/type-guards.js';
import {
  chooseFormBVariant,
  getChromeContentWidth,
  getRailActiveIndex,
  getRailDriftPassed,
  getRailStageCompletionTimes,
  getRailStages,
  isRailCurrent,
  railConnectorString,
  railFormBLabel,
  railIsHandoff,
  railShowsActivityRow,
  railStageRole,
  type RailForm,
  type RailRole,
  type RailStage,
  type RailStageState,
  type RailStageStatus,
} from '../layout/chrome-rows.js';
import {
  getRailStageZones,
  RAIL_FORM_C_CANCELLED_SUFFIX,
  resolveRailFraction,
} from '../layout/hit-test.js';

// The review/gate phases where the workflow pauses for approval: the activity line drops the live
// verb for the just-compiled artifact's done tail, so the planner's output is visible without hover.
const RAIL_GATE_PHASES: ReadonlySet<Phase> = new Set([
  'reviewing-spec',
  'reviewing-plan',
  'reviewing-briefs',
]);

interface RailDoneSummary {
  totalTasks: number;
  localCount: number;
  driftPassed: boolean | undefined;
}

// Artifact-summary tails on the done rows: a brief count, the local/total task ratio, and the
// drift verdict — each concrete and distinct (no two stages share a word).
function doneTail(stage: RailStage, summary: RailDoneSummary): string {
  switch (stage) {
    case 'spec':
      return 'compiled';
    case 'plan':
      return 'approved';
    case 'briefs':
      return summary.totalTasks > 0 ? countNoun(summary.totalTasks, 'brief') : 'written';
    case 'build':
      return summary.totalTasks > 0 ? `${summary.localCount}/${summary.totalTasks} local` : 'built';
    case 'verify':
      return summary.driftPassed === false ? 'drift found' : 'no drift';
    default:
      return assertNever(stage);
  }
}

function activeVerb(phase: Phase): string {
  switch (phase) {
    case 'researching':
      return 'researching…';
    case 'specifying':
      return 'specifying…';
    case 'reviewing-spec':
      return 'reviewing spec…';
    case 'clarifying':
      return 'clarifying…';
    case 'constitution-check':
      return 'checking constitution…';
    case 'planning':
      return 'compiling briefs from spec…';
    case 'reviewing-plan':
      return 'reviewing plan…';
    case 'reviewing-briefs':
      return 'reviewing briefs…';
    case 'analyzing':
      return 'analyzing…';
    case 'implementing':
      return 'implementing…';
    case 'validating-task':
      return 'validating…';
    case 'escalating':
      return 'escalating…';
    case 'final-review':
      return 'reviewing…';
    case 'idle':
    case 'complete':
      return '';
    default:
      return assertNever(phase);
  }
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

function formatStageElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  return `${minutes}:${seconds}`;
}

// Width-aware activity content. Verb and fraction are always kept; the file middle-truncates; the
// elapsed clock is dropped first when the row is tight.
function truncateActivity(opts: {
  verb: string;
  fraction: string;
  file: string;
  elapsed: string;
  available: number;
}): string {
  const { verb, fraction, file, elapsed, available } = opts;
  const head = fraction !== '' ? `${verb}${SOFT_SEP}task ${fraction}` : verb;
  const join = (...parts: string[]): string => parts.filter((part) => part !== '').join(SOFT_SEP);
  const full = join(head, file, elapsed);
  if (getTerminalCellWidth(full) <= available) return full;
  const withoutElapsed = join(head, file);
  if (getTerminalCellWidth(withoutElapsed) <= available) return withoutElapsed;
  if (file !== '') {
    const fileBudget = available - getTerminalCellWidth(head) - getTerminalCellWidth(SOFT_SEP);
    if (fileBudget > 0) {
      return `${head}${SOFT_SEP}${truncateTerminalDisplayTextMiddle(file, fileBudget)}`;
    }
  }
  return truncateTerminalDisplayText(head, Math.max(0, available));
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
  const rc = roleColor(railStageRole(state.stage), t);
  const label = railFormBLabel(state, { short });
  const left = index > 0 ? stages[index - 1] : undefined;
  const connector =
    left !== undefined
      ? {
          text: railConnectorString(railIsHandoff(left.stage, state.stage)),
          color: left.status === 'done' ? roleColor(railStageRole(left.stage), t) : t.textDim,
        }
      : undefined;
  return (
    <Box>
      {connector !== undefined && <Text color={connector.color}>{connector.text}</Text>}
      <Text color={rc} bold={live} dimColor={!live}>
        {`${stageMarkerGlyph(state.status)} ${label}`}
      </Text>
    </Box>
  );
}

interface RailActivity {
  activeIndex: number;
  role: RailRole;
  file: string;
  stageStart: number;
  isGate: boolean;
  doneTailText: string;
  fraction: string;
}

function RailActivityRow({
  activity,
  phase,
  cols,
  cancelled,
  contentWidth,
}: {
  activity: RailActivity;
  phase: Phase;
  cols: number;
  cancelled: boolean;
  contentWidth: number;
}) {
  const t = useTheme();
  const rc = roleColor(activity.role, t);
  const [, refresh] = useState(0);
  const { isGate, stageStart } = activity;

  useEffect(() => {
    if (isGate || stageStart <= 0) return;
    const id = setInterval(() => refresh((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [isGate, stageStart]);

  const zones = getRailStageZones({
    form: 'B',
    phase,
    cols,
    fraction: '',
    cancelled,
    leftCol: 0,
    topRow: 0,
  });
  const indent = zones.find((zone) => zone.index === activity.activeIndex)?.left ?? 0;
  const elbow = glyph('elbow');
  const elbowWidth = getTerminalCellWidth(elbow) + 1;

  if (isGate) {
    const available = Math.max(0, contentWidth - indent - elbowWidth);
    return (
      <Box height={1} overflow="hidden" width={contentWidth}>
        {indent > 0 && <Text>{' '.repeat(indent)}</Text>}
        <Text color={rc} dimColor>{`${elbow} `}</Text>
        <Text color={rc}>{truncateTerminalDisplayText(activity.doneTailText, available)}</Text>
      </Box>
    );
  }

  const available = Math.max(0, contentWidth - indent - elbowWidth - 2);
  const elapsed = stageStart > 0 ? formatStageElapsed(Date.now() - stageStart) : '';
  const text = truncateActivity({
    verb: activeVerb(phase),
    fraction: activity.fraction,
    file: activity.file,
    elapsed,
    available,
  });
  return (
    <Box height={1} overflow="hidden" width={contentWidth}>
      {indent > 0 && <Text>{' '.repeat(indent)}</Text>}
      <Text color={rc} dimColor>{`${elbow} `}</Text>
      <Spinner label={text} color={rc} />
    </Box>
  );
}

function RailFormB({
  stages,
  phase,
  cols,
  cancelled,
  contentWidth,
  activity,
}: {
  stages: RailStageState[];
  phase: Phase;
  cols: number;
  cancelled: boolean;
  contentWidth: number;
  activity: RailActivity | null;
}) {
  const { short } = chooseFormBVariant(stages, contentWidth);
  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      <Box height={1} />
      <Box height={1} overflow="hidden" width={contentWidth}>
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
      {activity !== null && (
        <RailActivityRow
          activity={activity}
          phase={phase}
          cols={cols}
          cancelled={cancelled}
          contentWidth={contentWidth}
        />
      )}
    </Box>
  );
}

function RailFormC({ stages, fraction }: { stages: RailStageState[]; fraction: string }) {
  const t = useTheme();
  const currentState = stages.find((state) => isRailCurrent(state.status));
  const fallback = stages.find((state) => state.status === 'pending') ?? stages[stages.length - 1];
  const state = currentState ?? fallback;
  const live = state?.status === 'active';
  const stage = state?.stage ?? 'spec';
  const rc = roleColor(railStageRole(state?.stage ?? 'spec'), t);
  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      <Box height={1} />
      <Box height={1} overflow="hidden">
        <Text color={rc} bold={live} dimColor={!live}>
          {`${stageMarkerGlyph(state?.status ?? 'pending')} ${stage}`}
        </Text>
        {state?.status === 'cancelled' && (
          <Text color={t.textDim}>{RAIL_FORM_C_CANCELLED_SUFFIX}</Text>
        )}
        {live && fraction !== '' && <Text color={t.textDim}>{`  task ${fraction}`}</Text>}
      </Box>
    </Box>
  );
}

function RailComplete({ summary }: { summary: RailDoneSummary }) {
  const t = useTheme();
  const parts = ['done'];
  if (summary.totalTasks > 0) parts.push(`${summary.localCount}/${summary.totalTasks} local`);
  parts.push(summary.driftPassed === false ? 'drift found' : 'no drift');
  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      <Box height={1} />
      <Box height={1} overflow="hidden">
        <Text color={t.success}>{`${glyph('statusDone')} ${parts.join(SOFT_SEP)}`}</Text>
      </Box>
    </Box>
  );
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
  const summary: RailDoneSummary = {
    totalTasks: tasks.totalTasks,
    localCount: tokens.localCount,
    driftPassed: getRailDriftPassed(eventsState.events),
  };
  const fraction = resolveRailFraction({
    phase,
    currentTask: tasks.currentTask,
    totalTasks: tasks.totalTasks,
    cancelled,
  });

  if (phase === 'complete') {
    return <RailComplete summary={summary} />;
  }
  if (resolved === 'C') {
    return <RailFormC stages={stages} fraction={fraction} />;
  }

  const activeIndex = getRailActiveIndex(phase);
  let activity: RailActivity | null = null;
  if (railShowsActivityRow('B', phase, cancelled)) {
    const activeStage = stages[activeIndex]?.stage ?? 'spec';
    const completionTimes = getRailStageCompletionTimes(eventsState.events);
    const stageStart =
      activeIndex > 0 ? (completionTimes[activeIndex - 1] ?? 0) : (lifecycle.startedAt ?? 0);
    const runningTask = tasks.tasks.find((task) => task.status === 'in_progress');
    activity = {
      activeIndex,
      role: railStageRole(activeStage),
      file: runningTask ? sanitizeTerminalDisplayText(runningTask.title) : '',
      stageStart,
      isGate: RAIL_GATE_PHASES.has(phase),
      doneTailText: doneTail(activeStage, summary),
      fraction,
    };
  }

  return (
    <RailFormB
      stages={stages}
      phase={phase}
      cols={cols}
      cancelled={cancelled}
      contentWidth={contentWidth}
      activity={activity}
    />
  );
}
