import type { Config } from '../../types.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './base.js';
import { createImplementerBase, createChangeDetector, DEFAULT_TIMEOUT } from './base.js';
import { isENOENT } from '../../utils/process.js';
import { spawnWithShellFallback, createProcessError } from '../../utils/process.js';
import type { SpawnResult } from '../../utils/process.js';

function substitutePrompt(args: string[], prompt: string): { args: string[]; useStdin: boolean } {
  const hasPlaceholder = args.some(a => a.includes('{prompt}'));
  if (!hasPlaceholder) return { args, useStdin: true };
  return {
    args: args.map(a => a.replace('{prompt}', prompt)),
    useStdin: false,
  };
}

function assertAgentSuccess(result: SpawnResult, timeout: number, command: string): void {
  if (result.code === 127) {
    throw new Error(`Agent implementer command not found: ${command}`);
  }
  if (result.timedOut) {
    throw createProcessError(`Agent implementer timed out after ${Math.round(timeout / 1000)}s`, result.output);
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw createProcessError(
      `Agent implementer exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
      result.output,
    );
  }
}

export function createAgentImplementer(config: Config): Implementer {
  return createImplementerBase({
    name: 'agent',
    pricingKey: config.implementer.tool,
    extractsCode: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, config: cfg, onProgress } = opts;
      const command = cfg.implementer.command!;
      const rawArgs = cfg.implementer.args ?? [];
      const timeout = cfg.implementer.timeout ?? DEFAULT_TIMEOUT;

      const { args, useStdin } = substitutePrompt(rawArgs, prompt);

      let result: SpawnResult;
      try {
        result = await spawnWithShellFallback({ command, args, cwd: projectDir, timeout, onProgress, stdinInput: useStdin ? prompt : undefined });
      } catch (err) {
        if (isENOENT(err)) throw new Error(`Agent implementer command not found: ${command}`);
        throw err;
      }

      assertAgentSuccess(result, timeout, command);
      return { text: result.output };
    },

    detectChanges: createChangeDetector('Agent implementer'),

    shouldThrow(err: unknown) {
      return err instanceof Error && err.message.includes('command not found');
    },

    async isAvailable() {
      return true;
    },
  });
}
