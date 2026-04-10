import type { Config } from '../../types.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './base.js';
import { createImplementerBase, createChangeDetector, DEFAULT_TIMEOUT, assertSpawnSuccess } from './base.js';
import { CommandNotFoundError, CommandTimeoutError, spawnWithTimeout } from '../../utils/process.js';
import type { SpawnResult } from '../../utils/process.js';
import type { CliPlannerTool } from '../../types.js';
import { CLI_TOOLS } from '../cli-tools.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { runClaudeOneShot } from '../claude-runner.js';
import { resolveAutoModel } from '../../core/providers/models.js';

export function createToolImplementer(toolName: CliPlannerTool, config: Config): Implementer {
  const tool = CLI_TOOLS[toolName];
  const timeout = config.implementer.timeout ?? DEFAULT_TIMEOUT;

  return createImplementerBase({
    extractsCode: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onOutput } = opts;
      const effectiveModel = resolveAutoModel(opts.config.implementer.model);

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
