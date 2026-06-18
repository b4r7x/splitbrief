import type { Config } from '../../core/schemas/config.js';
import type { OutputFormat } from '../../core/schemas/enums.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import type { RunnerCallContext } from '../calls/types.js';
import type { ChangeDetector } from '../change-detection.js';
import { createImplementerBase } from './base.js';
import { createCommandAvailability } from '../availability.js';
import { invokeCommandBasedRunner } from '../runners/command-based.js';

export interface CommandBasedImplementerOpts {
  initialCommand: string;
  label: string;
  extractsCode: boolean;
  backendKind?: RunnerCallContext['backendKind'] | undefined;
  supportPromptPlaceholder?: boolean | undefined;
  getRunnerConfig: (config: Config) => {
    command: string;
    args?: string[] | undefined;
    outputFormat?: OutputFormat | undefined;
    timeout?: number | undefined;
  };
  detectChanges?: ChangeDetector | undefined;
  shouldThrow?: ((err: unknown) => boolean) | undefined;
}

export function createCommandBasedImplementer(
  opts: CommandBasedImplementerOpts,
  options?: ImplementerFactoryOptions,
): Implementer {
  const notFoundMessage = `${opts.label} command not found: ${opts.initialCommand}`;

  return createImplementerBase({
    extractsCode: opts.extractsCode,
    backendKind: opts.backendKind ?? (opts.extractsCode ? 'shell' : 'agent'),
    publisher: options?.publisher,

    async invoke(invokeOpts: InvokeOpts) {
      const { prompt, projectDir, config, onOutput, signal } = invokeOpts;
      const cfg = opts.getRunnerConfig(config);

      const result = await invokeCommandBasedRunner({
        command: cfg.command,
        args: cfg.args ?? [],
        ...(cfg.outputFormat && { outputFormat: cfg.outputFormat }),
        ...(opts.supportPromptPlaceholder && { supportPromptPlaceholder: true }),
        ...(cfg.timeout !== undefined && { timeout: cfg.timeout }),
        notFoundMessage,
        prompt,
        projectDir,
        env: invokeOpts.sandboxEnv,
        onOutput,
        onCallEvent: invokeOpts.onCallEvent,
        callContext: invokeOpts.callContext,
        signal,
      });

      if (result.callResult.status !== 'completed') return result.callResult;
      return { text: result.stdout, usage: result.usage ?? null };
    },

    ...(opts.detectChanges && { detectChanges: opts.detectChanges }),
    ...(opts.shouldThrow && { shouldThrow: opts.shouldThrow }),
    ...createCommandAvailability(opts.initialCommand),
  });
}
