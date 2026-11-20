import type { Command } from 'commander';
import chalk from 'chalk';
import { plainTheme } from '../../core/theme/resolve.js';
import type { Theme } from '../../core/theme/palette.js';
import { paint } from '../../core/theme/paint.js';
import type { WorkflowState } from '../../core/schemas/workflow/state.js';
import { readSeatIdentityRecord } from '../../core/state/seats/record.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
} from '../../core/state/selectors.js';
import { canonicalizeProjectDir } from '../setup.js';
import { resolveTargetRun } from '../sessions/resolve.js';
import { sessionStatusWord } from '../../core/sessions/display.js';
import { rowFor } from '../../core/sessions/io.js';
import type { RunRecord } from '../../core/sessions/run/record.js';
import {
  CREW_SEAT_IDS,
  CREW_SEAT_LABELS,
  REVIEW_NONE,
  candidateIdsOf,
  formatSeatIdentity,
  type CrewSeatId,
} from '../../core/crew/identity.js';
import type { SeatIds } from '../../core/crew/seat-ids.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import {
  recordedRunnerKind,
  type CallIdentity,
} from '../../engine/orchestrator/summary/call-identities.js';
import { resolveCallIdentities } from '../../engine/orchestrator/summary/call-evidence.js';
import { oneLineDisplayText, stripTerminalControls } from '../../utils/display-text/sanitize.js';
import { recordedSeatIdentityInput } from '../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { loadRememberedCatalog } from '../bootstrap/discovery.js';
import { briefPosition } from '../../core/state/selectors.js';

const STATUS_LABEL_WIDTH = 'Escalated: '.length;

/** A seat as the run state recorded it, and the role its own calls were recorded under. */
type RecordedSeat = Readonly<{ seat: SeatIds; callRole: CallIdentity['role'] }>;

type RunRecords = Readonly<{
  state: WorkflowState;
  seats: ReturnType<typeof readSeatIdentityRecord>;
  evidence: ReturnType<typeof resolveCallIdentities>;
}>;

function seatIdentity(
  { state, seats, evidence }: RunRecords,
  seatId: CrewSeatId,
  seat: SeatIds,
  callRole: CallIdentity['role'],
): string {
  const switchIndex = state.seatSwitches?.findLastIndex((change) => change.seat === seatId) ?? -1;
  const switched = state.seatSwitches?.[switchIndex];
  const current =
    switched?.toSeat !== undefined &&
    (seats?.ids === undefined ||
      seats.switchCount === undefined ||
      switchIndex >= seats.switchCount)
      ? candidateIdsOf(switched.toSeat)
      : seats?.ids?.[seatId];
  const selected = current ?? seat;
  const recorded = selected.kind ?? recordedRunnerKind(evidence, callRole, selected.tool);
  // API vocabulary keeps an ambiguous legacy name literal without selecting a CLI.
  const kind = recorded === 'ambiguous' ? 'api' : recorded;
  const ids =
    current !== undefined
      ? current
      : kind === undefined || kind === 'cli'
        ? candidateIdsOf(selected)
        : selected;
  return stripTerminalControls(
    formatSeatIdentity(
      recordedSeatIdentityInput({
        seat: { ...ids, kind: kind ?? ids.kind },
        role: CREW_SEAT_ROLES[seatId],
        cache: modelCacheStore,
      }),
    ),
  );
}

function printRunLines(state: WorkflowState, run: RunRecord, theme: Theme): void {
  const { ref, status, summary, owner } = run;
  console.log(
    `${paint(theme.textDim, 'Feature:'.padEnd(STATUS_LABEL_WIDTH))}${chalk.bold(oneLineDisplayText(state.feature))}`,
  );
  const session = rowFor(
    {
      id: ref.sessionId,
      feature: state.feature,
      startedAt: Date.parse(state.startedAt),
      completedAt: null,
      stateVersion: state.stateVersion,
    },
    status,
    summary,
  );
  const statusWord =
    status.kind === 'running' && owner?.kind === 'stale'
      ? 'unresponsive'
      : sessionStatusWord(session);
  console.log(
    `${paint(theme.textDim, 'Status:'.padEnd(STATUS_LABEL_WIDTH))}${chalk.bold(statusWord)}`,
  );
  const brief = briefPosition(state);
  if (brief !== undefined) {
    console.log(
      `${paint(theme.textDim, 'Task:'.padEnd(STATUS_LABEL_WIDTH))}${brief.position}/${brief.total}`,
    );
  }
  console.log(`${paint(theme.textDim, 'Started:'.padEnd(STATUS_LABEL_WIDTH))}${state.startedAt}`);
  console.log(`${paint(theme.textDim, 'Session:'.padEnd(STATUS_LABEL_WIDTH))}${ref.sessionId}`);
}

function recordedCrew(state: WorkflowState): Record<CrewSeatId, RecordedSeat | undefined> {
  const plan: RecordedSeat | undefined = state.plannerTool
    ? {
        seat: { tool: state.plannerTool, model: state.plannerModel, kind: state.plannerKind },
        callRole: 'planner',
      }
    : undefined;
  return {
    plan,
    build: state.implementerTool
      ? {
          seat: {
            tool: state.implementerTool,
            model: state.implementerModel,
            kind: state.implementerKind,
          },
          callRole: 'implementer',
        }
      : undefined,
    review: state.reviewerTool
      ? {
          seat: {
            tool: state.reviewerTool,
            model: state.reviewerModel,
            kind: state.reviewerKind,
          },
          callRole: 'review',
        }
      : plan,
  };
}

function printCrewLines(records: RunRecords, theme: Theme): void {
  const { state, seats } = records;
  const crew = recordedCrew(state);
  // REVIEW's seat comes from the seat record, which a crew change rewrites during the run; a
  // record that keeps none leaves the seat the run state saved at the start. PLAN holds
  // REVIEW, switches included, until a REVIEW switch gives the review seat its own runner.
  const reviewSeat =
    seats?.reviewSeat ??
    (state.reviewerSeat === 'none' ? 'none' : state.reviewerTool ? 'own' : 'plan');
  const reviewHeldByPlan =
    reviewSeat === 'plan' && !state.seatSwitches?.some((change) => change.seat === 'review');
  for (const seatId of CREW_SEAT_IDS) {
    if (seatId === 'review' && reviewSeat === 'none') {
      console.log(
        `${paint(theme.textDim, `${CREW_SEAT_LABELS.review}:`.padEnd(STATUS_LABEL_WIDTH))}${REVIEW_NONE.mark}`,
      );
      continue;
    }
    const recorded = crew[seatId];
    if (recorded === undefined) continue;
    const holder = seatId === 'review' && reviewHeldByPlan ? 'plan' : seatId;
    console.log(
      `${paint(theme.textDim, `${CREW_SEAT_LABELS[seatId]}:`.padEnd(STATUS_LABEL_WIDTH))}${seatIdentity(records, holder, recorded.seat, recorded.callRole)}`,
    );
  }
}

function printTaskCounts(state: WorkflowState, theme: Theme): void {
  const completed = getCompletedTaskIds(state);
  const escalated = getEscalatedTaskIds(state);
  const failed = getFailedTaskIds(state);
  if (completed.length > 0) {
    console.log(
      `${paint(theme.textDim, 'Done:'.padEnd(STATUS_LABEL_WIDTH))}${paint(theme.success, String(completed.length))}`,
    );
  }
  if (escalated.length > 0) {
    console.log(
      `${paint(theme.textDim, 'Escalated:'.padEnd(STATUS_LABEL_WIDTH))}${paint(theme.warning, String(escalated.length))}`,
    );
  }
  if (failed.length > 0) {
    console.log(
      `${paint(theme.textDim, 'Failed:'.padEnd(STATUS_LABEL_WIDTH))}${paint(theme.error, String(failed.length))}`,
    );
  }
}

async function runStatus(opts: { project?: string }): Promise<void> {
  const projectDir = await canonicalizeProjectDir(opts);
  const theme = plainTheme();
  await loadRememberedCatalog(projectDir);

  const run = await resolveTargetRun({ projectDir });

  if (run === null || run.hydration.kind !== 'loaded') {
    console.log('No active workflow.');
    return;
  }
  const { ref } = run;
  const { state } = run.hydration;
  const records: RunRecords = {
    state,
    evidence: resolveCallIdentities(ref),
    seats: readSeatIdentityRecord(ref),
  };
  printRunLines(state, run, theme);
  printCrewLines(records, theme);
  printTaskCounts(state, theme);
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current workflow state')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(runStatus);
}
