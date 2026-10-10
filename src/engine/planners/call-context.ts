import type { RunnerCallContext } from '../calls/types.js';
import {
  createPlannerArtifactAttemptId,
  type PlannerArtifactTransport,
  type PlannerSessionScope,
} from '../../core/schemas/planner-artifact.js';

const DEFAULT_BACKEND_KIND: RunnerCallContext['backendKind'] = 'cli';

let plannerBaseCallSequence = 0;

export interface PlannerCallContextConfig {
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
  axes?: readonly string[] | undefined;
  transport?: PlannerArtifactTransport | undefined;
  sessionScope?: PlannerSessionScope | undefined;
}

export function createPlannerCallContext(
  config: PlannerCallContextConfig,
  role: RunnerCallContext['role'],
): RunnerCallContext {
  const attemptId = createPlannerArtifactAttemptId();
  return {
    callId: attemptId,
    attemptId,
    role,
    backendKind: config.backendKind ?? DEFAULT_BACKEND_KIND,
    ...(config.runnerName !== undefined && { runnerName: config.runnerName }),
    ...(config.model !== undefined && { model: config.model }),
    ...(config.axes !== undefined && { axes: config.axes }),
    attempt: ++plannerBaseCallSequence,
    transport: config.transport ?? { kind: 'stdout-final' },
    sessionScope: config.sessionScope ?? { kind: 'workflow', workflowSessionId: null },
  };
}
