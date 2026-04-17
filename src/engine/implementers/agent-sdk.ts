import type { Config } from '../../core/types/config-options.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './utils.js';
import { createImplementerBase } from './base.js';
import { createAgentSdkBackend, isAgentSdkAvailable, IMPLEMENTER_ALLOWED_TOOLS } from '../agent-sdk.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { DEFAULT_AGENT_SDK_MODEL } from '../../core/providers/known-models.js';

export function createAgentSdkImplementer(config: Config): Implementer {
  const apiKey = config.implementer.kind === 'agent-sdk' ? config.implementer.apiKey : undefined;
  const effectiveModel = resolveAutoModel(config.implementer.model, 'agent-sdk') ?? DEFAULT_AGENT_SDK_MODEL;
  const backend = createAgentSdkBackend({ allowedTools: [...IMPLEMENTER_ALLOWED_TOOLS], detectChanges: true, apiKey });

  return createImplementerBase({
    extractsCode: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onOutput } = opts;
      return backend.invoke({ prompt, projectDir, model: effectiveModel, onOutput });
    },

    ...(backend.detectChanges && { detectChanges: backend.detectChanges }),

    isAvailable: () => isAgentSdkAvailable(apiKey),
  });
}
