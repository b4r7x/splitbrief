import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import { createChangeDetector } from '../change-detection.js';
import { createImplementerBase } from './base.js';
import { spawnWithTimeout } from '../../lib/process/spawn.js';
import { processError } from '../../lib/process/errors.js';
import { CLI_TOOLS } from '../cli-tools.js';
import { createCommandAvailability } from '../availability.js';
import { runClaudeOneShot } from '../claude-invoke.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { runnerConfigError } from '../runners/errors.js';
import { IMPLEMENTER_TIMEOUT_MS } from '../constants.js';

export function createCliImplementer(config: CliImplementerConfig, options?: ImplementerFactoryOptions): Implementer {
  const toolName = config.tool;
  const tool = CLI_TOOLS[toolName];
  const timeout = config.timeout ?? IMPLEMENTER_TIMEOUT_MS;

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

      const result = await spawnWithTimeout({
        command: tool.command,
        args,
        cwd: projectDir,
        timeout,
        onProgress: onOutput,
        notFoundMessage: tool.notFoundMessage,
        signal,
      });

      const label = `Tool implementer (${toolName})`;
      if (result.code === 127) throw processError.notFound(label, tool.notFoundMessage);
      if (result.timedOut) {
        throw processError.timeout({ command: label, label, timeoutMs: timeout, output: result.output });
      }
      if (result.code !== 0) {
        throw processError.exitCode({ command: label, label, code: result.code, stderr: result.stderr, output: result.output });
      }

      return { text: result.output, usage: null };
    },

    detectChanges: createChangeDetector(`Tool implementer (${toolName})`),

    ...createCommandAvailability(tool.command),
  });
}
