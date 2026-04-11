import type { Config, ShellImplementerConfig } from '../../types.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './utils.js';
import { createImplementerBase } from './base.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { invokeCommandBasedRunner } from '../runners/command-based.js';
import { CommandNotFoundError } from '../../utils/process.js';

function asShellConfig(config: Config): ShellImplementerConfig {
  if (config.implementer.kind !== 'shell') throw new Error('Expected shell implementer config');
  return config.implementer;
}

export function createShellImplementer(initialConfig: Config): Implementer {
  const shellConfig = asShellConfig(initialConfig);
  const command = shellConfig.command;

  return createImplementerBase({
    extractsCode: true,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, config, onOutput } = opts;
      const impl = asShellConfig(config);

      try {
        const result = await invokeCommandBasedRunner(
          {
            command,
            args: impl.args ?? [],
            extractsCode: true,
            ...(impl.outputFormat && { outputFormat: impl.outputFormat }),
          },
          prompt,
          projectDir,
          onOutput,
        );

        return { text: result.stdout, usage: null };
      } catch (err) {
        if (err instanceof CommandNotFoundError) {
          throw new CommandNotFoundError(`Shell implementer command not found: ${command}`);
        }
        throw err;
      }
    },

    ...createCommandAvailability(command),
  });
}
