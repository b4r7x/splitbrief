import type { Config } from '../../types.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './base.js';
import { createImplementerBase, createChangeDetector, DEFAULT_TIMEOUT, assertSpawnSuccess } from './base.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { spawnWithShellFallback, type SpawnResult } from '../../utils/process.js';

function substitutePrompt(args: string[], prompt: string): { args: string[]; useStdin: boolean } {
  const hasPlaceholder = args.some(a => a.includes('{prompt}'));
  if (!hasPlaceholder) return { args, useStdin: true };
  return {
    args: args.map(a => a.replace('{prompt}', prompt)),
    useStdin: false,
  };
}

export function createAgentImplementer(config: Config): Implementer {
  const command = config.implementer.command ?? '';

  return createImplementerBase({
    extractsCode: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, config: cfg, onOutput } = opts;
      const cmd = cfg.implementer.command!;
      const rawArgs = cfg.implementer.args ?? [];
      const timeout = cfg.implementer.timeout ?? DEFAULT_TIMEOUT;

      const { args, useStdin } = substitutePrompt(rawArgs, prompt);

      const notFoundMessage = `Agent implementer command not found: ${cmd}`;

      const result: SpawnResult = await spawnWithShellFallback({ command: cmd, args, cwd: projectDir, timeout, onProgress: onOutput, stdinInput: useStdin ? prompt : undefined, notFoundMessage });

      assertSpawnSuccess(result, { label: 'Agent implementer', timeoutMs: timeout, notFoundMessage });
      return { text: result.output, usage: null };
    },

    detectChanges: createChangeDetector('Agent implementer'),

    ...createCommandAvailability(command),
  });
}
