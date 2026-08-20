import type { RunnerCallContext } from '../calls/types.js';
import {
  createTaskCompilationAttemptId,
  type PlannerArtifactTransport,
  type PlannerSessionScope,
  type TaskCompilationCallEnvelope,
  type TaskCompilationOperationEnvelope,
} from '../../core/schemas/task-compilation.js';

const DEFAULT_BACKEND_KIND: RunnerCallContext['backendKind'] = 'cli';

let plannerBaseCallSequence = 0;

export interface PlannerCallContextConfig {
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
  transport?: PlannerArtifactTransport | undefined;
  sessionScope?: PlannerSessionScope | undefined;
  envelope?: TaskCompilationCallEnvelope | undefined;
  operationEnvelope?: TaskCompilationOperationEnvelope | undefined;
}

export function createPlannerCallContext(
  config: PlannerCallContextConfig,
  role: RunnerCallContext['role'],
): RunnerCallContext {
  const attemptId = createTaskCompilationAttemptId();
  return {
    callId: attemptId,
    attemptId,
    role,
    backendKind: config.backendKind ?? DEFAULT_BACKEND_KIND,
    ...(config.runnerName !== undefined && { runnerName: config.runnerName }),
    ...(config.model !== undefined && { model: config.model }),
    attempt: ++plannerBaseCallSequence,
    transport: config.transport ?? { kind: 'stdout-final' },
    sessionScope: config.sessionScope ?? { kind: 'workflow', workflowSessionId: null },
    ...(config.envelope !== undefined && { envelope: config.envelope }),
    ...(config.operationEnvelope !== undefined && {
      operationEnvelope: config.operationEnvelope,
    }),
  };
}
