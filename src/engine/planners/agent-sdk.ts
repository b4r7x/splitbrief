import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { createAgentSdkBackend, isAgentSdkAvailable, PLANNER_ALLOWED_TOOLS } from '../agent-sdk.js';
import { DEFAULT_AGENT_SDK_MODEL, resolveAutoModel } from '../../core/providers/models.js';

export function createAgentSdkPlanner(model?: string): Planner {
  const effectiveModel = resolveAutoModel(model) ?? DEFAULT_AGENT_SDK_MODEL;
  const backend = createAgentSdkBackend({ allowedTools: [...PLANNER_ALLOWED_TOOLS] });

  const invoke = ({ prompt, projectDir, callbacks }: { prompt: string; projectDir: string; callbacks: { onOutput: (text: string) => void } }) =>
    backend.invoke({ prompt, projectDir, model: effectiveModel, onOutput: callbacks.onOutput });

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    isAvailable: isAgentSdkAvailable,
    escalateHintSuccess: (r) => r.text.length > 0,
  });
}
