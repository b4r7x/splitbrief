import type { Config } from '../../core/schemas/config.js';
import type { Implementer, ImplementerFactoryOptions } from './types.js';
import { assertImplementerKind } from './utils.js';
import { createCommandBasedImplementer } from './command-invoke.js';

export function createShellImplementer(initialConfig: Config, options?: ImplementerFactoryOptions): Implementer {
  const shellConfig = assertImplementerKind(initialConfig, 'shell');

  return createCommandBasedImplementer(
    {
      initialCommand: shellConfig.command,
      label: 'Shell implementer',
      extractsCode: true,
      getRunnerConfig: (config) => {
        const impl = assertImplementerKind(config, 'shell');
        return {
          command: impl.command,
          args: impl.args ?? [],
          outputFormat: impl.outputFormat,
        };
      },
    },
    options,
  );
}
