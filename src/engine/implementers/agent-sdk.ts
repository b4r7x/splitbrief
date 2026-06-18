import type { Config } from '../../core/schemas/config.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import { createImplementerBase } from './base.js';
import {
  createAgentSdkBackend,
  isAgentSdkAvailable,
  IMPLEMENTER_ALLOWED_TOOLS,
} from '../runners/agent-sdk-backend.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { DEFAULT_AGENT_SDK_MODEL } from '../../core/providers/known-models.js';
import { resolveApiKeyOverride } from '../providers/client.js';
import { composeAbortSignal } from '../../utils/abort.js';

export function createAgentSdkImplementer(
  config: Config,
  options?: ImplementerFactoryOptions,
): Implementer {
  const apiKey =
    config.implementer.kind === 'agent-sdk'
      ? resolveApiKeyOverride(config.implementer.apiKey)
      : undefined;
  const timeout = config.implementer.timeout;
  const effectiveModel =
    resolveAutoModel(config.implementer.model, 'agent-sdk') ?? DEFAULT_AGENT_SDK_MODEL;
  const backend = createAgentSdkBackend({
    allowedTools: [...IMPLEMENTER_ALLOWED_TOOLS],
    detectChanges: true,
    apiKey,
  });

  return createImplementerBase({
    extractsCode: false,
    backendKind: 'agent-sdk',
    publisher: options?.publisher,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onOutput, signal } = opts;
      const effectiveSignal = composeAbortSignal(signal, timeout);
      return backend.invoke({
        prompt,
        projectDir,
        model: effectiveModel,
        onOutput,
        onCallEvent: opts.onCallEvent,
        callContext: opts.callContext,
        signal: effectiveSignal,
        env: opts.sandboxEnv,
      });
    },

    ...(backend.detectChanges && { detectChanges: backend.detectChanges }),

    isAvailable: () => isAgentSdkAvailable(apiKey),
  });
}
