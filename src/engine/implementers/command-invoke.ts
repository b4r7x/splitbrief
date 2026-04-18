import type { Config } from '../../core/types/config-options.js';
import type { OutputFormat } from '../../core/schemas/enums.js';
import type { Implementer } from './types.js';
import type { InvokeOpts } from './utils.js';
import { createImplementerBase } from './base.js';
import { createCommandAvailability } from '../../lib/availability.js';
import { invokeCommandBasedRunner } from '../runners/command-based.js';

export interface CommandBasedImplementerOpts {
  initialCommand: string;
  label: string;
  extractsCode: boolean;
  supportPromptPlaceholder?: boolean | undefined;
  getRunnerConfig: (config: Config) => {
    command: string;
    args?: string[] | undefined;
    outputFormat?: OutputFormat | undefined;
    timeout?: number | undefined;
  };
  detectChanges?: ((projectDir: string, before: string[]) => Promise<{ changed: boolean; output: string }>) | undefined;
  shouldThrow?: ((err: unknown) => boolean) | undefined;
}

/**
 * Creates a command-based implementer (shared setup for shell + agent kinds).
 * Handles: invoke wiring via invokeCommandBasedRunner, availability, and base implementer construction.
 */
export function createCommandBasedImplementer(opts: CommandBasedImplementerOpts): Implementer {
  const notFoundMessage = `${opts.label} command not found: ${opts.initialCommand}`;

  return createImplementerBase({
    extractsCode: opts.extractsCode,

    async invoke(invokeOpts: InvokeOpts) {
      const { prompt, projectDir, config, onOutput, signal } = invokeOpts;
      const cfg = opts.getRunnerConfig(config);

      const result = await invokeCommandBasedRunner(
        {
          command: cfg.command,
          args: cfg.args ?? [],
          extractsCode: opts.extractsCode,
          ...(cfg.outputFormat && { outputFormat: cfg.outputFormat }),
          ...(opts.supportPromptPlaceholder && { supportPromptPlaceholder: true }),
          ...(cfg.timeout !== undefined && { timeout: cfg.timeout }),
          notFoundMessage,
        },
        prompt,
        projectDir,
        onOutput,
        signal,
      );

      return { text: result.stdout, usage: result.usage ?? null };
    },

    ...(opts.detectChanges && { detectChanges: opts.detectChanges }),
    ...(opts.shouldThrow && { shouldThrow: opts.shouldThrow }),
    ...createCommandAvailability(opts.initialCommand),
  });
}
