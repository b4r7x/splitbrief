import type { EngineEventOf } from '../../../src/engine/events/types.js';
import { makeRunnerCallActivity } from './runner-call.js';

export function makeRunnerActivity(
  overrides?: Partial<EngineEventOf<'runner_call_activity'>>,
): EngineEventOf<'runner_call_activity'> {
  return makeRunnerCallActivity({
    ts: 1_200,
    phase: 'implementing',
    sequence: 3,
    activityId: 'call-1:tool:1',
    label: 'running npm test',
    target: 'npm test',
    ...overrides,
  });
}
