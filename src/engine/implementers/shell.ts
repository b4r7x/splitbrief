import type { Config } from '../../core/schemas/config.js';
import type { Implementer, ImplementerFactoryOptions } from './types.js';
import { IMPLEMENTER_TIMEOUT_MS } from '../constants.js';
import { assertImplementerKind } from '../config-assertions.js';
import { createCommandBasedImplementer } from './command-invoke.js';

export function createShellImplementer(
  initialConfig: Config,
  options?: ImplementerFactoryOptions,
): Implementer {
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
          timeout: config.implementer.timeout ?? IMPLEMENTER_TIMEOUT_MS,
        };
      },
    },
    options,
  );
}
