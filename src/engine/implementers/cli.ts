import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import { createChangeDetector } from '../change-detection.js';
import { createImplementerBase } from './base.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { parseTextLine } from '../streaming/parse-text.js';
import { processError } from '../../lib/process/errors.js';
import { CLI_TOOLS } from '../cli-tools.js';
import { createCommandAvailability } from '../availability.js';
import { runClaudeOneShot } from '../claude-invoke.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { runnerConfigError } from '../runners/errors.js';
import { IMPLEMENTER_TIMEOUT_MS } from '../constants.js';

export function createCliImplementer(
  config: CliImplementerConfig,
  options?: ImplementerFactoryOptions,
): Implementer {
  const toolName = config.tool;
  const tool = CLI_TOOLS[toolName];
  const timeout = config.timeout ?? IMPLEMENTER_TIMEOUT_MS;

  return createImplementerBase({
    extractsCode: false,
    publisher: options?.publisher,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onOutput, signal } = opts;
      const effectiveModel = resolveAutoModel(config.model, toolName);
      const timeoutSignal = AbortSignal.timeout(timeout);
      const composedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      try {
        if (toolName === 'claude-code') {
          return await runClaudeOneShot({
            prompt,
            projectDir,
            onOutput,
            model: effectiveModel,
            signal: composedSignal,
          });
        }

        if (!tool.implementer) throw runnerConfigError.missingToolConfig(toolName, 'implementer');
        const args = tool.implementer.buildArgs({ prompt, model: effectiveModel });

        return await spawnAndCollect({
          command: tool.command,
          args,
          cwd: projectDir,
          parseLine: tool.implementer.parseLine ?? parseTextLine,
          notFoundMessage: tool.notFoundMessage,
          onText: onOutput,
          signal: composedSignal,
        });
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw processError.timeout({
            command: `Tool implementer (${toolName})`,
            label: `Tool implementer (${toolName})`,
            timeoutMs: timeout,
            output: '',
          });
        }
        if (signal?.aborted) throw err;
        throw err;
      }
    },

    detectChanges: createChangeDetector(`Tool implementer (${toolName})`),

    ...createCommandAvailability(tool.command),
  });
}
