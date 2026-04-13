import type { Config } from '../../types.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './utils.js';
import { createImplementerBase } from './base.js';
import { createAgentSdkBackend, isAgentSdkAvailable, IMPLEMENTER_ALLOWED_TOOLS } from '../agent-sdk.js';
import { resolveAutoModel } from '../../core/providers.js';
import { DEFAULT_AGENT_SDK_MODEL } from '../providers/known.js';

export function createAgentSdkImplementer(config: Config): Implementer {
  const effectiveModel = resolveAutoModel(config.implementer.model) ?? DEFAULT_AGENT_SDK_MODEL;
  const backend = createAgentSdkBackend({ allowedTools: [...IMPLEMENTER_ALLOWED_TOOLS], detectChanges: true });

  return createImplementerBase({
    extractsCode: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onOutput } = opts;
      return backend.invoke({ prompt, projectDir, model: effectiveModel, onOutput });
    },

    ...(backend.detectChanges && { detectChanges: backend.detectChanges }),

    isAvailable: isAgentSdkAvailable,
  });
}
