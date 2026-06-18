import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import { createChangeDetector } from '../change-detection.js';
import { createImplementerBase } from './base.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { parseTextLine } from '../streaming/parse-text.js';
import { getLineParser } from '../streaming/output-parsers.js';
import { processError } from '../../lib/process/errors.js';
import { CLI_TOOLS } from '../runners/cli-tools.js';
import { createCommandAvailability } from '../availability.js';
import { runClaudeOneShot } from '../runners/claude-invoke.js';
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
    backendKind: 'cli',
    publisher: options?.publisher,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onOutput, signal, callContext } = opts;
      const effectiveModel = resolveAutoModel(config.model, toolName);
      const timeoutSignal = AbortSignal.timeout(timeout);
      const composedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const env = opts.sandboxEnv;

      try {
        if (toolName === 'claude-code') {
          return await runClaudeOneShot({
            prompt,
            projectDir,
            onOutput,
            model: effectiveModel,
            permissionMode: 'acceptEdits',
            signal: composedSignal,
            env,
          });
        }

        if (!tool.implementer) throw runnerConfigError.missingToolConfig(toolName, 'implementer');
        const builtArgs = tool.implementer.buildArgs({ prompt, model: effectiveModel });
        const args = config.args ? [...builtArgs, ...config.args] : builtArgs;
        const parseLine = config.outputFormat
          ? getLineParser(config.outputFormat)
          : (tool.implementer.parseLine ?? parseTextLine);

        return await spawnAndCollect({
          command: tool.command,
          args,
          cwd: projectDir,
          env,
          parseLine,
          notFoundMessage: tool.notFoundMessage,
          onText: onOutput,
          callContext,
          signal: composedSignal,
        });
      } catch (err: unknown) {
        if (timeoutSignal.aborted && !signal?.aborted) {
          throw processError.timeout({
            command: `Tool implementer (${toolName})`,
            label: `Tool implementer (${toolName})`,
            timeoutMs: timeout,
            output: '',
          });
        }
        throw err;
      }
    },

    detectChanges: createChangeDetector(`Tool implementer (${toolName})`),

    ...createCommandAvailability(tool.command),
  });
}
