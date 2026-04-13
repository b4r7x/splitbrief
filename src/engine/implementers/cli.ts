import type { CliImplementerConfig } from '../../types.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './utils.js';
import { createChangeDetector, DEFAULT_TIMEOUT, assertSpawnSuccess } from './utils.js';
import { createImplementerBase } from './base.js';
import { CommandNotFoundError, CommandTimeoutError, spawnWithTimeout } from '../../utils/process.js';
import type { SpawnResult } from '../../utils/process.js';
import { CLI_TOOLS } from '../cli-tools.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { runClaudeOneShot } from '../claude-runner.js';
import { resolveAutoModel } from '../../core/providers.js';

export function createCliImplementer(config: CliImplementerConfig): Implementer {
  const toolName = config.tool;
  const tool = CLI_TOOLS[toolName];
  const timeout = config.timeout ?? DEFAULT_TIMEOUT;

  return createImplementerBase({
    extractsCode: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onOutput } = opts;
      const effectiveModel = resolveAutoModel(config.model, toolName);

      if (toolName === 'claude-code') {
        return runClaudeOneShot({ prompt, projectDir, onOutput, model: effectiveModel });
      }

      if (!tool.implementer) {
        throw new Error(`Tool ${toolName} has no implementer buildArgs in CLI_TOOLS`);
      }
      const args = tool.implementer.buildArgs({ prompt, model: effectiveModel });

      const result: SpawnResult = await spawnWithTimeout({ command: tool.command, args, cwd: projectDir, timeout, onProgress: onOutput, notFoundMessage: tool.notFoundMessage });

      assertSpawnSuccess(result, {
        label: `Tool implementer (${toolName})`,
        timeoutMs: timeout,
        notFoundMessage: tool.notFoundMessage,
      });

      return { text: result.output, usage: null };
    },

    detectChanges: createChangeDetector(`Tool implementer (${toolName})`),

    shouldThrow(err: unknown) {
      return err instanceof CommandNotFoundError || err instanceof CommandTimeoutError;
    },

    ...createCommandAvailability(tool.command),
  });
}
