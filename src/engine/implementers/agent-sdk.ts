import type { Config } from '../../types.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './base.js';
import { createImplementerBase, createChangeDetector } from './base.js';
import { loadSdk, processStream } from '../agent-sdk.js';
import { DEFAULT_AGENT_SDK_MODEL } from '../../core/providers/models.js';

const DEFAULT_MODEL = DEFAULT_AGENT_SDK_MODEL;
const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

export function createAgentSdkImplementer(config: Config): Implementer {
  const effectiveModel = config.implementer.model || DEFAULT_MODEL;

  return createImplementerBase({
    extractsCode: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onProgress } = opts;
      const model = opts.config.implementer.model || effectiveModel;
      const { query } = await loadSdk();

      return processStream(
        query({ prompt, options: { allowedTools: ALLOWED_TOOLS, permissionMode: 'acceptEdits', model, cwd: projectDir } }),
        onProgress,
      );
    },

    detectChanges: createChangeDetector('Agent SDK implementer'),
  });
}
