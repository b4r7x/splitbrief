import type { Phase } from '../../core/schemas/enums.js';
import {
  applyStopRailStages,
  getRailStages,
  type RailHalt,
  type RailStageState,
  type RailStageStatus,
} from '../../core/rail-stages.js';
import type { RunRecord } from '../../core/sessions/run-record.js';
import { awaitsApply, type StopReason } from '../../core/sessions/run-status.js';
import type { RouteData } from '../../stores/navigation/router.js';
import type { DepartureKind } from '../../stores/workflow/departure.js';
import { AT_REST_PLACEHOLDER } from './closed/byline.js';

/**
 * A stop the operator can answer wears the cancel mark; a stop the run could not get past wears the
 * failure mark. One reading of the rail: warning means "waiting for you", error means "it broke".
 */
function stopMark(stop: StopReason): RailHalt {
  return stop.on.kind === 'halt' || stop.on.kind === 'failed' ? 'failed' : 'cancelled';
}

/**
 * The phase the record stands in: the saved state first, then what the summary recorded, then what
 * the summary carries, so a legacy summary still stops the rail at the right stage. A final review
 * that failed is the review stage until it is accepted as is.
 */
export function recordPhase(record: RunRecord): Phase {
  const state = record.hydration.kind === 'loaded' ? record.hydration.state : null;
  const failedReview =
    state?.phase === 'complete' &&
    state.reviewStatus === 'failed' &&
    state.acceptedAsIs === undefined;
  if (failedReview) return 'final-review';
  const summary = record.summary;
  const recorded = state?.phase ?? summary?.phase ?? 'idle';
  // `idle` is where a run that never started stands, so it names no stage.
  if (recorded !== 'idle' || summary === null) return recorded;
  if (summary.stoppedAt !== undefined || summary.totalTasks > 0) return 'implementing';
  if (summary.reviewPacket !== undefined) return 'final-review';
  return 'planning';
}

/**
 * The header rail of a run nothing is running: a finished run shows every stage done, and every
 * other run marks the stage it stopped on with the mark its own stop earned.
 */
export function atRestRailStages(record: RunRecord): RailStageState[] {
  const status = record.status;
  const apply = applyStage(record);
  const applyOption = apply === undefined ? {} : { apply };
  if (status.kind === 'running') return getRailStages(recordPhase(record), applyOption);
  if (status.kind === 'ready-to-apply') return getRailStages('complete', applyOption);
  if (status.kind === 'closed') {
    return status.as === 'complete' || status.as === 'applied' || status.as === 'undone'
      ? getRailStages('complete', applyOption)
      : getRailStages(recordPhase(record), { halted: 'cancelled', ...applyOption });
  }
  if (status.resumeAt.kind === 'apply') return applyStopRailStages(stopMark(status.stop));
  return getRailStages(recordPhase(record), { halted: stopMark(status.stop), ...applyOption });
}

/**
 * The mark a brief left in progress wears while nothing runs it: the mark its run's stop earned on
 * the rail, so the transcript header, the sidebar and the rail say one thing. A run still running
 * has no rest mark.
 */
export function atRestBriefMark(record: RunRecord): RailHalt | null {
  const status = record.status;
  if (status.kind === 'open') return stopMark(status.stop);
  if (status.kind === 'closed') return 'cancelled';
  return null;
}

/** The rest mark of the run on screen: none unless the workflow screen shows its run at rest. */
export function routeBriefMark(route: RouteData): RailHalt | null {
  return route.screen === 'workflow' && route.execution.kind === 'at-rest'
    ? atRestBriefMark(route.run)
    : null;
}

/**
 * A run a process holds while its reviewed result still waits for the checkout: Apply is writing it.
 * The record says `running` for any process that holds the run, so the saved state tells Apply apart.
 */
export function applyRunning(record: RunRecord): boolean {
  return (
    record.status.kind === 'running' &&
    record.hydration.kind === 'loaded' &&
    awaitsApply(record.hydration.state)
  );
}

/**
 * The Apply stage a workspace run wears on its header rail once its review passed. Before that the
 * rail shows Plan, Build and Review, as the live rail of the same run does. A run with no workspace,
 * one whose workspace is the checkout itself, or an ended run nothing can apply has no Apply stage.
 */
export function applyStage(record: RunRecord): RailStageStatus | undefined {
  if (record.hydration.kind !== 'loaded') return undefined;
  const workspace = record.hydration.state.workspace;
  if (workspace === undefined || workspace.kind === 'checkout') return undefined;
  const status = record.status;
  if (applyRunning(record)) return 'active';
  if (status.kind === 'ready-to-apply') return 'pending';
  if (status.kind !== 'closed') return undefined;
  if (status.as === 'applied') return 'done';
  // An undone Apply reverted the checkout, as a discard leaves it; kept later edits break nothing.
  if (status.as === 'undone' || status.as === 'discarded') return 'cancelled';
  return undefined;
}

export interface AtRestComposer {
  /** Whether typing into the composer continues this run. */
  continuable: boolean;
  commandsOnly: boolean;
  placeholder: string;
}

/**
 * What the composer of a run at rest takes. A run that can be picked up takes a correction and a
 * bare Enter; anything else takes commands only, so Enter never promises work that cannot happen.
 * Behind this window's Apply, Enter queues home, which a queued quit already overrides; `apply` is
 * absent when no Apply of this window writes the run, so Enter goes home at once.
 */
export function atRestComposer(
  record: RunRecord,
  apply?: Readonly<{ queued: DepartureKind | null }>,
): AtRestComposer {
  const continuable = record.status.kind === 'open' && record.hydration.kind === 'loaded';
  return {
    continuable,
    commandsOnly: !continuable,
    placeholder:
      record.status.kind === 'ready-to-apply'
        ? AT_REST_PLACEHOLDER.ready
        : apply !== undefined
          ? applyComposer(apply.queued).placeholder
          : !continuable
            ? AT_REST_PLACEHOLDER.closed
            : record.status.kind === 'open' && record.status.stop.on.kind === 'question'
              ? AT_REST_PLACEHOLDER.inputRequired
              : AT_REST_PLACEHOLDER.open,
  };
}

/** The composer behind this process's Apply, live or at rest: commands only, Enter queues home. */
export function applyComposer(queued: DepartureKind | null): AtRestComposer {
  return {
    continuable: false,
    commandsOnly: true,
    placeholder: queued === 'quit' ? AT_REST_PLACEHOLDER.quitting : AT_REST_PLACEHOLDER.applying,
  };
}
