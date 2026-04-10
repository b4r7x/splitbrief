import type { Config, OutputFormat } from '../../types.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './base.js';
import { createImplementerBase } from './base.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';

export function createShellImplementer(config: Config): Implementer {
  const command = config.implementer.command ?? '';

  return createImplementerBase({
    extractsCode: true,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, config: cfg, onOutput } = opts;
      const args = cfg.implementer.args ?? [];
      const format: OutputFormat = cfg.implementer.outputFormat ?? 'text';

      return spawnAndCollect({
        command: command,
        args,
        cwd: projectDir,
        stdin: prompt,
        format,
        notFoundMessage: `Shell implementer command not found: ${command}`,
        onText: onOutput,
      });
    },

    ...createCommandAvailability(command),
  });
}

