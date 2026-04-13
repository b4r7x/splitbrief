import type { Config, AgentImplementerConfig } from '../../types.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './utils.js';
import { DEFAULT_TIMEOUT, createChangeDetector } from './utils.js';
import { createImplementerBase } from './base.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { invokeCommandBasedRunner } from '../runners/command-based.js';

function asAgentConfig(config: Config): AgentImplementerConfig {
  if (config.implementer.kind !== 'agent') throw new Error('Expected agent implementer config');
  return config.implementer;
}

export function createAgentImplementer(initialConfig: Config): Implementer {
  const agentConfig = asAgentConfig(initialConfig);
  const command = agentConfig.command;

  return createImplementerBase({
    extractsCode: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, config, onOutput } = opts;
      const impl = asAgentConfig(config);
      const cmd = impl.command;
      const timeout = config.implementer.timeout ?? DEFAULT_TIMEOUT;

      const notFoundMessage = `Agent implementer command not found: ${cmd}`;

      const result = await invokeCommandBasedRunner(
        {
          command: cmd,
          args: impl.args,
          outputFormat: impl.outputFormat,
          extractsCode: false,
          supportPromptPlaceholder: true,
          timeout,
          notFoundMessage,
        },
        prompt,
        projectDir,
        onOutput,
      );

      return { text: result.stdout, usage: null };
    },

    detectChanges: createChangeDetector('Agent implementer'),

    ...createCommandAvailability(command),
  });
}
