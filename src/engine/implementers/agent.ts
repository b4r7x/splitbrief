import type { Config } from '../../types.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './base.js';
import { createImplementerBase, createChangeDetector, DEFAULT_TIMEOUT, assertSpawnSuccess } from './base.js';
import { isENOENT } from '../../utils/process.js';
import { spawnWithShellFallback } from '../../utils/process.js';
import type { SpawnResult } from '../../utils/process.js';

function substitutePrompt(args: string[], prompt: string): { args: string[]; useStdin: boolean } {
  const hasPlaceholder = args.some(a => a.includes('{prompt}'));
  if (!hasPlaceholder) return { args, useStdin: true };
  return {
    args: args.map(a => a.replace('{prompt}', prompt)),
    useStdin: false,
  };
}

export function createAgentImplementer(_config: Config): Implementer {
  return createImplementerBase({
    extractsCode: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, config: cfg, onProgress } = opts;
      const command = cfg.implementer.command!;
      const rawArgs = cfg.implementer.args ?? [];
      const timeout = cfg.implementer.timeout ?? DEFAULT_TIMEOUT;

      const { args, useStdin } = substitutePrompt(rawArgs, prompt);

      const notFoundMessage = `Agent implementer command not found: ${command}`;

      let result: SpawnResult;
      try {
        result = await spawnWithShellFallback({ command, args, cwd: projectDir, timeout, onProgress, stdinInput: useStdin ? prompt : undefined });
      } catch (err) {
        if (isENOENT(err)) throw new Error(notFoundMessage);
        throw err;
      }

      assertSpawnSuccess(result, { label: 'Agent implementer', timeoutMs: timeout, notFoundMessage });
      return { text: result.output };
    },

    detectChanges: createChangeDetector('Agent implementer'),

    shouldThrow(err: unknown) {
      return err instanceof Error && err.message.includes('command not found');
    },
  });
}
