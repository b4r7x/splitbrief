import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { Implementer, ImplementerFactoryOptions } from './types.js';
import type { InvokeOpts } from './utils.js';
import { DEFAULT_TIMEOUT, assertSpawnSuccess } from './utils.js';
import { createChangeDetector } from '../change-detection.js';
import { createImplementerBase } from './base.js';
import { spawnWithTimeout } from '../../lib/process/spawn.js';
import type { SpawnResult } from '../../lib/process/spawn.js';
import { CLI_TOOLS } from '../cli-tools.js';
import { createCommandAvailability } from '../../lib/availability.js';
import { runClaudeOneShot } from '../claude-invoke.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { runnerConfigError } from '../runners/errors.js';

export function createCliImplementer(config: CliImplementerConfig, options?: ImplementerFactoryOptions): Implementer {
  const toolName = config.tool;
  const tool = CLI_TOOLS[toolName];
  const timeout = config.timeout ?? DEFAULT_TIMEOUT;

  return createImplementerBase({
    extractsCode: false,
    publisher: options?.publisher,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onOutput, signal } = opts;
      const effectiveModel = resolveAutoModel(config.model, toolName);

      if (toolName === 'claude-code') {
        return runClaudeOneShot({ prompt, projectDir, onOutput, model: effectiveModel });
      }

      if (!tool.implementer) throw runnerConfigError.missingToolConfig(toolName, 'implementer');
      const args = tool.implementer.buildArgs({ prompt, model: effectiveModel });

      const result: SpawnResult = await spawnWithTimeout({ command: tool.command, args, cwd: projectDir, timeout, onProgress: onOutput, notFoundMessage: tool.notFoundMessage, signal });

      assertSpawnSuccess(result, {
        label: `Tool implementer (${toolName})`,
        timeoutMs: timeout,
        notFoundMessage: tool.notFoundMessage,
      });

      return { text: result.output, usage: null };
    },

    detectChanges: createChangeDetector(`Tool implementer (${toolName})`),

    ...createCommandAvailability(tool.command),
  });
}
