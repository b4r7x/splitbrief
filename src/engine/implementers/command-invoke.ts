import type { Config } from '../../core/schemas/config.js';
import type { OutputFormat } from '../../core/schemas/enums.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import type { RunnerCallContext } from '../calls/types.js';
import type { ChangeDetector } from '../change-detection.js';
import { createImplementerBase } from './pipeline/run.js';
import { createCommandExistsAvailability } from '../availability.js';
import { createChangeDetector } from '../change-detection.js';
import {
  customRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from '../runners/custom-trust.js';
import { prepareCustomRunnerAdmission } from '../runners/custom-admission.js';
import { customRunnerAdmissionError } from '../runners/trust.js';
import type { CustomRunnerRuntimePort } from '../runners/types.js';
import {
  invokeCommandBasedRunner,
  invokeCustomCommandBasedRunner,
} from '../runners/command-based.js';

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
    idleWarnMs?: number | undefined;
    idleKillMs?: number | undefined;
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
        ...(opts.supportPromptPlaceholder &&
          options?.allowRepoRunners && { allowShellEvaluatedPrompt: true }),
        ...(cfg.timeout !== undefined && { timeout: cfg.timeout }),
        ...(cfg.idleWarnMs !== undefined && { idleWarnMs: cfg.idleWarnMs }),
        ...(cfg.idleKillMs !== undefined && { idleKillMs: cfg.idleKillMs }),
        notFoundMessage,
        prompt,
        projectDir,
        env: invokeOpts.sandboxEnv,
        onOutput,
        onCallEvent: invokeOpts.onCallEvent,
        callContext: invokeOpts.callContext,
        signal,
      });

      return result.callResult;
    },

    ...(opts.detectChanges && { detectChanges: opts.detectChanges }),
    ...(opts.shouldThrow && { shouldThrow: opts.shouldThrow }),
    ...createCommandExistsAvailability(opts.initialCommand),
  });
}

export interface ConfiguredCustomImplementerOptions {
  readonly runner: ConfiguredCustomRunner;
  readonly runtime: CustomRunnerRuntimePort;
  readonly factoryOptions?: ImplementerFactoryOptions | undefined;
}

/**
 * Adapts an already-configured custom implementer to the common implementer
 * pipeline. Admission, executable identity, and child environment authority
 * remain in the custom-runner boundary; this adapter only selects the correct
 * project stage for the configured command contract.
 */
export function createConfiguredCustomImplementer({
  runner,
  runtime,
  factoryOptions,
}: ConfiguredCustomImplementerOptions): Implementer {
  const extractsCode = runner.command.contract === 'output';

  return createImplementerBase({
    extractsCode,
    backendKind: extractsCode ? 'shell' : 'agent',
    publisher: factoryOptions?.publisher,

    async invoke(invokeOpts: InvokeOpts) {
      const admission = await prepareCustomRunnerAdmission({
        ...runtime.admission,
        projectDir: runtime.authorizationProjectDir,
        runner,
        posture: customRunnerSecurityPosture('implementer', runner.command.contract),
        phase: 'implementing',
        taskId: invokeOpts.task.id,
        authorizationPathEnv: runtime.authorizationPathEnv ?? '',
        authorizationPathExt: runtime.authorizationPathExt ?? '',
      });
      if (admission.kind !== 'admitted') {
        throw customRunnerAdmissionError.denied('implementer');
      }

      const invokeAdmittedRunner = (cwd: string) =>
        invokeCustomCommandBasedRunner({
          admission: admission.invocation,
          prompt: invokeOpts.prompt,
          authorizationProjectDir: runtime.authorizationProjectDir,
          authorizationPathEnv: runtime.authorizationPathEnv ?? '',
          authorizationPathExt: runtime.authorizationPathExt ?? '',
          cwd,
          sourceEnv: runtime.sourceEnv,
          onOutput: invokeOpts.onOutput,
          onCallEvent: invokeOpts.onCallEvent,
          callContext: invokeOpts.callContext,
          signal: invokeOpts.signal,
        });

      if (!extractsCode) return invokeAdmittedRunner(invokeOpts.projectDir);

      const stage = await runtime.createStage(invokeOpts.projectDir, 'implementer');
      try {
        return await invokeAdmittedRunner(stage.projectDir);
      } finally {
        stage.cleanup();
      }
    },

    ...(!extractsCode && {
      detectChanges: createChangeDetector('Configured custom implementer'),
    }),
  });
}
