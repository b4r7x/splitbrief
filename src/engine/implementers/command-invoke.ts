import type { Config } from '../../core/schemas/config.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import { createImplementerBase } from './pipeline/run.js';
import { createCommandExistsAvailability } from '../availability.js';
import { createChangeDetector } from '../change-detection.js';
import { assertImplementerKind } from '../config-assertions.js';
import type { AdmittedCustomRunnerInvocation } from '../runners/custom-launchability.js';
import type { CustomRunnerRuntimePort } from '../runners/types.js';
import { createRunnerSandboxEnv } from '../runners/sandbox-env.js';
import { invokeCommandRunner } from '../runners/command-based.js';

/** A shell implementer returns code on stdout; an agent implementer writes the files itself. */
export function createCommandImplementer(
  initialConfig: Config,
  kind: 'shell' | 'agent',
  options?: ImplementerFactoryOptions,
): Implementer {
  const { command } = assertImplementerKind(initialConfig, kind);
  const label = kind === 'shell' ? 'Shell implementer' : 'Agent implementer';
  const notFoundMessage = `${label} command not found: ${command}`;

  return createImplementerBase({
    extractsCode: kind === 'shell',
    backendKind: kind,
    publisher: options?.publisher,

    async invoke(invokeOpts: InvokeOpts) {
      const { projectDir, config } = invokeOpts;
      const runner = assertImplementerKind(config, kind);

      return invokeCommandRunner({
        source: {
          kind: 'config',
          runner,
          env:
            invokeOpts.sandboxEnv ??
            (await createRunnerSandboxEnv(projectDir, config.implementer, 'implementer')),
          notFoundMessage,
        },
        prompt: invokeOpts.prompt,
        cwd: projectDir,
        callContext: invokeOpts.callContext,
        timeoutMs: runner.timeout,
        signal: invokeOpts.signal,
        onOutput: invokeOpts.onOutput,
        onCallEvent: invokeOpts.onCallEvent,
      });
    },

    ...(kind === 'agent' && { detectChanges: createChangeDetector(label) }),
    ...createCommandExistsAvailability(command),
  });
}

export interface ConfiguredCustomImplementerOptions {
  readonly runtime: CustomRunnerRuntimePort;
  readonly admission: AdmittedCustomRunnerInvocation;
  /** The seat's opt-in total (`timeout`); unset, the call has no deadline. */
  readonly timeoutMs?: number | undefined;
  readonly factoryOptions?: ImplementerFactoryOptions | undefined;
}

/**
 * Adapts an already-configured custom implementer to the common implementer
 * pipeline. Admission, executable identity, and child environment authority
 * remain in the custom-runner boundary; this adapter only selects the correct
 * project stage for the configured command contract.
 */
export function createConfiguredCustomImplementer({
  runtime,
  admission,
  timeoutMs,
  factoryOptions,
}: ConfiguredCustomImplementerOptions): Implementer {
  const extractsCode = admission.runner.command.contract === 'output';

  return createImplementerBase({
    extractsCode,
    backendKind: extractsCode ? 'shell' : 'agent',
    publisher: factoryOptions?.publisher,

    async invoke(invokeOpts: InvokeOpts) {
      const invokeAdmittedRunner = (cwd: string) =>
        invokeCommandRunner({
          source: {
            kind: 'admitted',
            admission,
            authorizationProjectDir: runtime.authorizationProjectDir,
            authorizationPathEnv: runtime.authorizationPathEnv,
            authorizationPathExt: runtime.authorizationPathExt,
            sourceEnv: runtime.sourceEnv,
          },
          prompt: invokeOpts.prompt,
          cwd,
          callContext: invokeOpts.callContext,
          timeoutMs,
          signal: invokeOpts.signal,
          onOutput: invokeOpts.onOutput,
          onCallEvent: invokeOpts.onCallEvent,
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
