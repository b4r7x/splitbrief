import { MARK_SLOT_CELLS } from '../../../../components/row-leading.js';
import { seatWaitMoved } from '../../../../core/sessions/held-seat.js';
import { seatWaitParts } from '../../../../core/sessions/seat-wait-line.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { useSharedClock } from '../../../../hooks/use-shared-clock.js';
import { preparationStore } from '../../../../stores/navigation/preparation.js';
import { configStore } from '../../../../stores/project/config.js';
import { departureStore } from '../../../../stores/workflow/departure.js';
import { runViewStore } from '../../../../stores/workflow/run-view.js';
import { applyRunning } from '../../at-rest.js';
import { bylineParts, legendText, runClosedLabel } from '../../closed/byline.js';
import { applyByline, openRunBylineParts } from '../../closed/open-byline.js';
import { getChromeContentWidth } from '../../layout/chrome-rows.js';
import type { useWorkflowScreen } from './use-model.js';

/**
 * The rows around the composer of a run at rest or in Apply: the label of the rule above it, the
 * byline with its seat wait and Apply clock, and the key legend.
 */
export function useAtRestByline(input: {
  model: Pick<
    ReturnType<typeof useWorkflowScreen>,
    'atRestRecord' | 'applying' | 'closedView' | 'continuable' | 'inputHint' | 'observing'
  >;
  cols: number;
  /** The run on screen is closed, so the rule above the composer ends it. */
  closed: boolean;
  confirming: boolean;
  scrollAboveLabel: string;
  scrollBelowLabel: string;
}) {
  const { model, cols, scrollBelowLabel } = input;
  // The at-rest and Apply bylines carry no pip, so they open on the text column and their budget is
  // what is left of the chrome row past the mark slot.
  const bylineWidth = Math.max(1, getChromeContentWidth(cols) - MARK_SLOT_CELLS);
  const config = configStore.use((state) => state.config);
  const atRestStatus = model.atRestRecord?.status;
  const owner = model.atRestRecord?.owner;
  const viewWait = runViewStore.use((view) => view.seatWait);
  // An open run continues with this window's crew, so its saved wait on a tool the seat no longer
  // runs waits no more. A run another process drives waits on the crew that process loaded.
  const wait =
    viewWait === null ||
    (atRestStatus?.kind === 'open' && config !== null && seatWaitMoved(viewWait.wait, config))
      ? null
      : viewWait;
  // The run's log names when an Apply started, here or in another process. A log written before it
  // did leaves another process's Apply to the running line, which has no clock to get wrong.
  const applyClock = runViewStore.use((view) => view.apply);
  const planCard = runViewStore.use((view) => view.planCard);
  const waitingForAnswer = runViewStore.use((view) => (view.questions?.length ?? 0) > 0);
  const failure = runViewStore.use((view) => view.failure);
  const applying =
    model.applying ||
    (model.atRestRecord !== undefined &&
      applyRunning(model.atRestRecord) &&
      applyClock?.until === null);
  // A wait's text goes when its reset passes, so the byline needs the clock while one shows at the
  // clock's own sample: the tick that passes the reset is the frame that drops the wait.
  const now = useSharedClock({
    active: (sample) =>
      applying || (wait !== null && seatWaitParts(wait.tool, wait.wait.resetAt, sample) !== null),
  });
  // The rule above the composer ends a closed run: it says so, before what still waits below.
  const ruleLabel = input.closed
    ? [runClosedLabel(model.closedView?.closedAt ?? null), scrollBelowLabel]
        .filter((part) => part !== '')
        .join(SOFT_SEP)
    : scrollBelowLabel;
  const queuedDeparture = departureStore.use((state) => state?.kind ?? null);
  // This process's Apply reads 0:00 until the bus delivers its start.
  const apply = applying
    ? {
        elapsedMs:
          applyClock === null ? 0 : Math.max(0, (applyClock.until ?? now) - applyClock.since),
        queued: queuedDeparture,
      }
    : undefined;
  const byline =
    atRestStatus === undefined
      ? apply === undefined
        ? undefined
        : applyByline(apply, bylineWidth)
      : model.closedView !== null && owner?.kind !== 'stale'
        ? apply !== undefined
          ? applyByline({ ...apply, cleanup: true }, bylineWidth)
          : bylineParts(model.closedView, bylineWidth)
        : openRunBylineParts({
            status: atRestStatus,
            owner,
            waitingForAnswer,
            observing: model.observing,
            wait,
            planCard,
            failure,
            continuable: model.continuable,
            width: bylineWidth,
            now,
            apply,
            confirming: input.confirming,
          });
  // A check running for this run owns Escape and says so on the byline, so the legend above the
  // composer does not offer it for going home at the same time. Neither does a quit queued behind
  // Apply, which Escape no longer changes.
  const checking = preparationStore.use((state) => state.kind === 'checking');
  const legend =
    model.atRestRecord === undefined && !model.applying
      ? model.inputHint
      : legendText({
          overflow: input.scrollAboveLabel !== '' || scrollBelowLabel !== '',
          width: getChromeContentWidth(cols),
          canGoHome: !checking && queuedDeparture !== 'quit',
          canOpenCommands: !checking,
        });
  return { ruleLabel, byline, legend };
}
