import type { CrewSeatId } from '../../core/crew/identity.js';
import type { Config } from '../../core/schemas/config.js';
import type { WorkflowState } from '../../core/schemas/workflow/state.js';
import type { EventBus } from '../events/types.js';
import type { ModelCacheAccessor } from '../providers/model/resolution.js';
import { reviewSeatRunNote } from '../spec/plan-checks.js';
import { publishInfo } from './events.js';
import { checkRegistry } from './validation/run-checks.js';

/** After a REVIEW seat change, the run says when the new seat cannot see the run's renders. */
export function publishReviewSeatRenderNote(input: {
  bus: EventBus;
  seat: CrewSeatId;
  state: Pick<WorkflowState, 'phase' | 'plan' | 'tasks'>;
  config: Config;
  modelCache: ModelCacheAccessor | undefined;
}): void {
  if (input.seat !== 'review') return;
  const { plan, tasks, phase } = input.state;
  const note = reviewSeatRunNote(
    [...checkRegistry({ plan, tasks }).values()],
    input.config,
    input.modelCache,
  );
  if (note !== undefined) publishInfo({ bus: input.bus, phase, message: note });
}
