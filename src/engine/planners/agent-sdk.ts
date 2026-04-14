import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { createAgentSdkBackend, isAgentSdkAvailable, PLANNER_ALLOWED_TOOLS } from '../agent-sdk.js';
import { resolveAutoModel } from '../../core/providers.js';
import { DEFAULT_AGENT_SDK_MODEL } from '../../core/providers/known-models.js';

export function createAgentSdkPlanner(model?: string, apiKey?: string): Planner {
  const effectiveModel = resolveAutoModel(model, 'agent-sdk') ?? DEFAULT_AGENT_SDK_MODEL;
  const backend = createAgentSdkBackend({ allowedTools: [...PLANNER_ALLOWED_TOOLS], apiKey });

  const invoke = ({ prompt, projectDir, callbacks }: { prompt: string; projectDir: string; callbacks: { onOutput: (text: string) => void } }) =>
    backend.invoke({ prompt, projectDir, model: effectiveModel, onOutput: callbacks.onOutput });

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    isAvailable: () => isAgentSdkAvailable(apiKey),

    capabilities: {
      supportsConversationalPlanning: true,
      supportsHintEscalation: false,
      supportsSessionResume: true,
      supportsMidStreamInjection: true,
    },
  });
}
