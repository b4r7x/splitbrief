import type { Config } from '../../core/types/config-options.js';
import type { Implementer } from './types.js';
import { DEFAULT_TIMEOUT, assertImplementerKind } from './utils.js';
import { createChangeDetector } from '../change-detection.js';
import { createCommandBasedImplementer } from './command-invoke.js';

export function createAgentImplementer(initialConfig: Config): Implementer {
  const agentConfig = assertImplementerKind(initialConfig, 'agent');

  return createCommandBasedImplementer({
    initialCommand: agentConfig.command,
    label: 'Agent implementer',
    extractsCode: false,
    supportPromptPlaceholder: true,
    getRunnerConfig: (config) => {
      const impl = assertImplementerKind(config, 'agent');
      return {
        command: impl.command,
        args: impl.args,
        outputFormat: impl.outputFormat,
        timeout: config.implementer.timeout ?? DEFAULT_TIMEOUT,
      };
    },
    detectChanges: createChangeDetector('Agent implementer'),
  });
}
