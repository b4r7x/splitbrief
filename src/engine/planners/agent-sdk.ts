import type { Planner } from './types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { CONVERSATIONAL_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createAgentSdkBackend } from '../runners/agent-sdk/backend.js';
import { isAgentSdkAvailable } from '../runners/agent-sdk/availability.js';

const PLANNER_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const PLANNER_PERMISSION_MODE = 'plan' as const;
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { DEFAULT_AGENT_SDK_MODEL } from '../../core/providers/known-models.js';
import { resolveApiKeyOverride } from '../providers/client/api-key.js';
import { composeAbortSignal } from '../../utils/abort.js';
import type { RunnerCallContext } from '../calls/types.js';
import { toTokenDelta } from '../calls/projection.js';

export function createAgentSdkPlanner(opts: {
  model?: string | undefined;
  apiKey?: string | undefined;
  initialSessionId?: string | null | undefined;
  effort?: EffortLevel | undefined;
  timeout?: number | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}): Planner {
  const { model, initialSessionId, effort, timeout, idleWarnMs, idleKillMs } = opts;
  const apiKey = resolveApiKeyOverride(opts.apiKey);
  const effectiveModel = resolveAutoModel(model, 'agent-sdk') ?? DEFAULT_AGENT_SDK_MODEL;
  const backend = createAgentSdkBackend({
    allowedTools: [...PLANNER_ALLOWED_TOOLS],
    permissionMode: PLANNER_PERMISSION_MODE,
    role: 'planner',
    apiKey,
    initialSessionId: initialSessionId ?? null,
    idleWarnMs,
    idleKillMs,
  });

  const invoke = ({
    prompt,
    projectDir,
    callbacks,
    images,
    signal,
    callContext,
  }: {
    prompt: string;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: {
      onOutput: (text: string) => void;
      onSessionId?: ((id: string) => void) | undefined;
      onSessionExpired?: ((id: string) => void) | undefined;
      onCallEvent?: Parameters<typeof backend.invoke>[0]['onCallEvent'];
    };
    images?: Attachment[] | undefined;
    signal?: AbortSignal | undefined;
  }) => {
    const effectiveSignal = composeAbortSignal(signal, timeout);
    return backend.invoke({
      prompt,
      projectDir,
      model: effectiveModel,
      onOutput: callbacks.onOutput,
      onSessionId: callbacks.onSessionId,
      onSessionExpired: callbacks.onSessionExpired,
      onCallEvent: callbacks.onCallEvent,
      callContext,
      ...(effort !== undefined && { effort }),
      ...(images && images.length > 0 ? { images } : {}),
      ...(effectiveSignal !== undefined && { signal: effectiveSignal }),
    });
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    backendKind: 'agent-sdk',
    runnerName: 'agent-sdk',
    model: effectiveModel,
    isAvailable: () => isAgentSdkAvailable(apiKey),

    async injectUserTurn(injection): Promise<TokenDelta | null> {
      const effectiveSignal = composeAbortSignal(injection.signal, timeout);
      const result = await backend.invoke({
        prompt: injection.text,
        projectDir: injection.projectDir,
        model: effectiveModel,
        onOutput: () => {},
        ...(injection.callbacks?.onCallEvent !== undefined && {
          onCallEvent: injection.callbacks.onCallEvent,
        }),
        ...(injection.callContext !== undefined && { callContext: injection.callContext }),
        ...(effort !== undefined && { effort }),
        ...(effectiveSignal !== undefined && { signal: effectiveSignal }),
      });
      return toTokenDelta(result.usage);
    },

    capabilities: CONVERSATIONAL_CAPS,
  });
}
