import { fauxPlanner } from './planner.js';
import { fauxImplementer } from './implementer.js';
import { makeBusRecorder } from '../orchestrator-factories.js';
import { makeConfig } from '../factories/config.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';

export function createFauxWorkflow(opts?: {
  planner?: Parameters<typeof fauxPlanner>[0];
  implementer?: Parameters<typeof fauxImplementer>[0];
}) {
  const { planner, state: plannerState } = fauxPlanner(opts?.planner);
  const { implementer, state: implementerState } = fauxImplementer(opts?.implementer);
  const { bus, events } = makeBusRecorder();
  const config = makeConfig();

  function eventsOfType<T extends EngineEvent['type']>(
    type: T,
  ): Extract<EngineEvent, { type: T }>[] {
    return events.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
  }

  return {
    planner,
    implementer,
    plannerState,
    implementerState,
    events,
    eventsOfType,
    bus,
    config,
  };
}
