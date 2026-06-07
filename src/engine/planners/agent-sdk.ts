import type { Planner } from './types.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { CONVERSATIONAL_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import {
  createAgentSdkBackend,
  isAgentSdkAvailable,
  PLANNER_ALLOWED_TOOLS,
  PLANNER_PERMISSION_MODE,
} from '../runners/agent-sdk-backend.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { DEFAULT_AGENT_SDK_MODEL } from '../../core/providers/known-models.js';
import { resolveApiKeyOverride } from '../providers/client.js';

export function createAgentSdkPlanner(opts: {
  model?: string | undefined;
  apiKey?: string | undefined;
  initialSessionId?: string | null | undefined;
  effort?: EffortLevel | undefined;
}): Planner {
  const { model, initialSessionId, effort } = opts;
  const apiKey = resolveApiKeyOverride(opts.apiKey);
  const effectiveModel = resolveAutoModel(model, 'agent-sdk') ?? DEFAULT_AGENT_SDK_MODEL;
  const backend = createAgentSdkBackend({
    allowedTools: [...PLANNER_ALLOWED_TOOLS],
    permissionMode: PLANNER_PERMISSION_MODE,
    apiKey,
    initialSessionId: initialSessionId ?? null,
  });

  const invoke = ({
    prompt,
    projectDir,
    callbacks,
    images,
    signal,
  }: {
    prompt: string;
    projectDir: string;
    callbacks: {
      onOutput: (text: string) => void;
      onSessionId?: ((id: string) => void) | undefined;
      onSessionExpired?: ((id: string) => void) | undefined;
    };
    images?: Attachment[] | undefined;
    signal?: AbortSignal | undefined;
  }) =>
    backend.invoke({
      prompt,
      projectDir,
      model: effectiveModel,
      onOutput: callbacks.onOutput,
      onSessionId: callbacks.onSessionId,
      onSessionExpired: callbacks.onSessionExpired,
      ...(effort !== undefined && { effort }),
      ...(images && images.length > 0 ? { images } : {}),
      ...(signal !== undefined && { signal }),
    });

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    isAvailable: () => isAgentSdkAvailable(apiKey),

    async injectUserTurn(text: string, projectDir: string): Promise<void> {
      await backend.invoke({
        prompt: text,
        projectDir,
        model: effectiveModel,
        onOutput: () => {},
        ...(effort !== undefined && { effort }),
      });
    },

    capabilities: CONVERSATIONAL_CAPS,
  });
}
