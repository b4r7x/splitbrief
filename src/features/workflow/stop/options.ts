import {
  isApplyUnfinishedAtRest,
  routerStore,
  type RouteData,
} from '../../../stores/navigation/router.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { selectRunningBrief, selectTaskListView } from '../../../core/run-view/briefs.js';
import type { RunView } from '../../../core/run-view/reduce.js';
import { stopStore, type StopState } from '../../../stores/workflow/stop.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { activeApply } from '../../../engine/orchestrator/session-lifecycle/shutdown.js';
import { changedFileCount } from '../closed/projections.js';
import { stopKeptFiles } from './copy.js';
import { routeClosedAtRest } from '../at-rest.js';
import {
  BACK_HINT,
  CONFIRM_HINT,
  formatKeyHints,
  SELECT_HINT,
} from '../../../components/key-legend.js';

export type StopRowId =
  | 'stop-now'
  | 'pause-after-brief'
  | 'keep-running'
  | 'end-run'
  | 'resume'
  | 'leave'
  | 'retry-stop';

export interface StopRow {
  readonly id: StopRowId;
  readonly label: string;
  /** What the run looks like after the row is chosen, in the same voice on every row. */
  readonly consequence: string;
}

export const STOP_SHEET_TITLE = 'Stop options';
export const STOP_SHEET_LEGEND = formatKeyHints([
  SELECT_HINT,
  CONFIRM_HINT,
  { key: 'esc', verb: 'stop' },
  { key: 'tab', verb: 'close' },
]);
export const STOP_SHEET_PARKED_LEGEND = formatKeyHints([
  SELECT_HINT,
  CONFIRM_HINT,
  BACK_HINT,
  { key: 'tab', verb: 'close' },
]);
export const STOP_SHEET_COMPOSER_HINT = 'Choose an action above…';

export interface StopSheetInput {
  readonly halted?: boolean;
  readonly currentTaskId: string | null;
  readonly nextTaskId: string | null;
  /** The run has changes to keep. */
  readonly hasChanges?: boolean | undefined;
  readonly boundaryPauseRequested: boolean;
  /**
   * The files a put-back of the running brief still acts on after its last revert, restore or
   * denied write; at 0 it has no partial changes to keep. Null or absent while no such row was read.
   */
  readonly briefKept?: number | null | undefined;
  /** The run pass has REVIEW None, so no brief ends in a review. */
  readonly reviewNone?: boolean | undefined;
}

export function stopSheetRows(input: StopSheetInput): StopRow[] {
  const rows: StopRow[] = [
    {
      id: 'stop-now',
      label: 'Stop now',
      consequence: input.halted
        ? 'park the run; keep it open'
        : input.currentTaskId === null || input.briefKept === 0
          ? 'stop execution; keep the run open'
          : 'stop execution; keep partial changes',
    },
  ];
  // A pause that is already pending has nothing left to ask for: the second row is the way back.
  if (input.boundaryPauseRequested) {
    rows.push({
      id: 'keep-running',
      label: 'Keep running',
      consequence: 'cancel the pause; the run continues',
    });
  } else if (input.currentTaskId !== null) {
    rows.push({
      id: 'pause-after-brief',
      label: 'Pause after this brief',
      consequence: `finish ${input.currentTaskId} including ${input.reviewNone === true ? 'checks' : 'checks and review'}; do not start ${input.nextTaskId ?? 'another brief'}`,
    });
  }
  rows.push({
    id: 'end-run',
    label: 'End run',
    consequence:
      input.hasChanges === true
        ? 'stop execution; close this run; keep changes'
        : 'stop execution; close this run',
  });
  return rows;
}

/** What the stop menu reads: the stop, the route, the run view, this process's Apply, the draft. */
export interface StopMenuInput {
  readonly stop: Pick<StopState, 'phase' | 'intent' | 'parked'>;
  readonly route: RouteData;
  readonly view: Pick<
    RunView,
    'briefs' | 'phase' | 'briefKept' | 'reviewNone' | 'stopKept' | 'halt'
  >;
  /** This process applies the run. */
  readonly applying: boolean;
  /** The composer holds a draft. */
  readonly hasDraft: boolean;
}

export function stopMenuRows(input: StopMenuInput): StopRow[] {
  const { stop, route } = input;
  if (stop.phase === 'failed')
    return [
      {
        id: 'retry-stop',
        label: 'Retry stop',
        consequence: 'retry cleanup and saving; do not start new work',
      },
    ];
  const atRest = route.screen === 'workflow' && route.execution.kind === 'at-rest';
  // A process that holds the run is applying it or driving it, and this process's Apply cannot be
  // cut: nothing here may continue, stop or end it.
  if ((atRest && route.run.status.kind === 'running') || input.applying)
    return [
      {
        id: 'leave',
        label: 'Back to sessions',
        consequence: input.hasDraft
          ? 'return home; keep the run and draft'
          : 'return home; keep the run',
      },
    ];
  if (stop.phase === 'parked' || stop.phase === 'ended' || atRest) {
    const closed = stop.phase === 'ended' || routeClosedAtRest(route);
    // A ready run cannot be continued: Apply and Discard live in its result menu, and End run
    // discards it the same way.
    const ready = atRest && route.run.status.kind === 'ready-to-apply';
    return [
      ...(ready
        ? [
            {
              id: 'end-run' as const,
              label: 'End run',
              consequence:
                changedFileCount(route.run.summary) === 0
                  ? 'discard the result; it changed no files'
                  : 'discard the result; save its changes in run.patch',
            },
          ]
        : !closed
          ? [
              {
                id: 'resume' as const,
                label: 'Resume',
                consequence: input.hasDraft
                  ? 'continue this run; keep the unsent draft'
                  : 'continue this run',
              },
              ...(isApplyUnfinishedAtRest(route)
                ? []
                : [
                    {
                      id: 'end-run' as const,
                      label: 'End run',
                      consequence: runHasChanges(input)
                        ? 'close this run; keep changes'
                        : 'close this run',
                    },
                  ]),
            ]
          : []),
      {
        id: 'leave',
        label: 'Back to sessions',
        consequence: input.hasDraft
          ? 'return home; keep the run and draft'
          : 'return home; keep the run',
      },
    ];
  }
  if (stop.intent !== 'none' && stop.intent !== 'pause-after-brief')
    return [
      {
        id: 'leave',
        label: 'Back after stop',
        consequence: 'return to sessions once cleanup and saving finish',
      },
    ];
  const { briefs, phase, briefKept, reviewNone, halt } = input.view;
  const brief = selectRunningBrief(briefs, phase);
  const rows = stopSheetRows({
    halted: halt?.issue != null,
    currentTaskId: brief.current?.id ?? null,
    nextTaskId: brief.next?.id ?? null,
    hasChanges: runHasChanges(input),
    boundaryPauseRequested: stop.intent === 'pause-after-brief',
    briefKept,
    reviewNone,
  });
  const issue = halt?.issue ?? null;
  // A halt offers only the actions it accepts: an unfinished Apply's halt refuses End run.
  return issue === null
    ? rows
    : rows.filter(
        (row) =>
          row.id === 'stop-now' ||
          (row.id === 'end-run' && issue.availableActions.includes('end-run')),
      );
}

/**
 * A finished brief left changes behind. A stop that cut a brief kept the files the byline names, and
 * no others. Without a stop to say so, a brief that started or failed may have written, unless a
 * revert, a restore or a denial left none of its writes changed.
 */
function runHasChanges({
  stop,
  route,
  view: { briefs, phase, stopKept, briefKept },
}: StopMenuInput): boolean {
  const view = selectTaskListView(briefs);
  if (view.finished > 0) return true;
  const record =
    route.screen === 'workflow' && route.execution.kind === 'at-rest' ? route.run : null;
  const kept = stopKeptFiles(stop.parked, record, stopKept);
  if (kept !== null) return kept.length > 0;
  return (selectRunningBrief(briefs, phase).current !== null && briefKept !== 0) || view.failed > 0;
}

/**
 * What every row keeps: the run's changes once a brief has made some, and the draft while the
 * composer holds one. A run that keeps neither names nothing.
 */
export function stopSheetFooter(input: { hasChanges: boolean; hasDraft: boolean }): string | null {
  if (input.hasChanges) return input.hasDraft ? 'Changes and draft stay.' : 'Changes stay.';
  if (input.hasDraft) return 'Draft stays.';
  return null;
}

export function stopMenuFooter(input: StopMenuInput): string | null {
  return stopSheetFooter({ hasChanges: runHasChanges(input), hasDraft: input.hasDraft });
}

/** The stop menu input as the stores hold it now, for a reader outside render. */
export function readStopMenuInput(): StopMenuInput {
  return {
    stop: stopStore.get(),
    route: routerStore.get(),
    view: runViewStore.get(),
    applying: activeApply() !== undefined,
    hasDraft: !composerLiveStore.get().empty,
  };
}

export function readStopMenuRows(): StopRow[] {
  return stopMenuRows(readStopMenuInput());
}
