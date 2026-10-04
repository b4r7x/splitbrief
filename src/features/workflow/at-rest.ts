import type { Phase } from '../../core/schemas/enums.js';
import {
  getRailStages,
  type RailHalt,
  type RailStageState,
  type RailStageStatus,
} from '../../core/rail-stages.js';
import type { RunRecord } from '../../core/sessions/run-record.js';
import type { StopKind } from '../../core/schemas/run-step.js';
import { AT_REST_PLACEHOLDER } from './closed/byline.js';

/**
 * A stop the operator can answer wears the cancel mark; a stop the run could not get past wears the
 * failure mark. One reading of the rail: warning means "waiting for you", error means "it broke".
 */
const STOP_HALT: Record<StopKind, RailHalt> = {
  paused: 'cancelled',
  waiting: 'cancelled',
  interrupted: 'cancelled',
  halted: 'failed',
  failed: 'failed',
  'input-required': 'cancelled',
};

/** The phase the record stands in: the saved state first, then what the summary recorded. */
export function recordPhase(record: RunRecord): Phase {
  if (record.hydration.kind === 'loaded') return record.hydration.state.phase;
  return record.summary?.phase ?? 'idle';
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
    return status.as === 'complete' || status.as === 'applied'
      ? getRailStages('complete', applyOption)
      : getRailStages(recordPhase(record), { halted: 'cancelled', ...applyOption });
  }
  const phase = status.resumeAt.kind === 'apply' ? 'complete' : recordPhase(record);
  return getRailStages(phase, { halted: STOP_HALT[status.stop.kind], ...applyOption });
}

/**
 * The Apply stage a workspace run wears on its header rail. A run with no workspace, or one whose
 * workspace is the checkout itself, has no Apply stage to show.
 */
export function applyStage(record: RunRecord): RailStageStatus | undefined {
  if (record.hydration.kind !== 'loaded') return undefined;
  const workspace = record.hydration.state.workspace;
  if (workspace === undefined || workspace.kind === 'checkout') return undefined;
  const status = record.status;
  if (status.kind === 'ready-to-apply') return 'pending';
  if (status.kind === 'closed') {
    if (status.as === 'applied') return 'done';
    if (status.as === 'discarded') return 'cancelled';
  }
  if (status.kind === 'open' && status.resumeAt.kind === 'apply') {
    return STOP_HALT[status.stop.kind];
  }
  return 'pending';
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
 */
export function atRestComposer(record: RunRecord): AtRestComposer {
  const continuable = record.status.kind === 'open' && record.hydration.kind === 'loaded';
  return {
    continuable,
    commandsOnly: !continuable,
    placeholder:
      record.status.kind === 'ready-to-apply'
        ? AT_REST_PLACEHOLDER.ready
        : !continuable
          ? AT_REST_PLACEHOLDER.closed
          : record.status.kind === 'open' && record.status.stop.kind === 'input-required'
            ? AT_REST_PLACEHOLDER.inputRequired
            : AT_REST_PLACEHOLDER.open,
  };
}
