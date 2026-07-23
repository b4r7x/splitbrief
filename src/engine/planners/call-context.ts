import type { RunnerCallContext } from '../calls/types.js';

const DEFAULT_BACKEND_KIND: RunnerCallContext['backendKind'] = 'cli';

let plannerBaseCallSequence = 0;

export interface PlannerCallContextConfig {
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
}

export function createPlannerCallContext(
  config: PlannerCallContextConfig,
  role: RunnerCallContext['role'],
): RunnerCallContext {
  return {
    callId: `planner-${++plannerBaseCallSequence}`,
    role,
    backendKind: config.backendKind ?? DEFAULT_BACKEND_KIND,
    ...(config.runnerName !== undefined && { runnerName: config.runnerName }),
    ...(config.model !== undefined && { model: config.model }),
  };
}
