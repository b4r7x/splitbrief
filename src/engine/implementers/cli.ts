import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import type { OutputFormat } from '../../core/schemas/enums.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import { createChangeDetector } from '../change-detection.js';
import { createImplementerBase } from './pipeline/run.js';
import { processError } from '../../lib/process/errors.js';
import {
  CLI_NO_DEADLINE_MS,
  CLI_PROMPT_PLACEHOLDER,
  invokeCliAdapter,
  toCliEnvironment,
} from '../runners/invoke-cli-adapter.js';
import { createCommandExistsAvailability } from '../availability.js';
import { resolveCliModel } from '../../core/providers/automatic-model.js';
import { resolveCliExecutableAliases } from '../runners/resolve-cli-executable.js';
import { assertCliStartGate, type CliStartGate } from '../runners/start-gate.js';
import { matches } from '../../utils/error.js';
import { createRunnerSandboxEnv, resolveCliRunnerAuth } from '../runners/sandbox-env.js';
import { withOutputFormat } from '../runners/cli-tools/output-format.js';
import { lookupCliImplementerAdapter } from '../runners/cli-tools/registry.js';
import type { CliImplementerAdapter } from '../runners/cli-tools/contract.js';

const isCliExecutableUnavailable = matches('cli-executable-unavailable');

function cliNotFoundMessage(displayName: string, installUrl: string): string {
  return `${displayName} not found. Install it from ${installUrl}`;
}

function resolveImplementerAdapter(
  toolName: CliImplementerConfig['tool'],
  outputFormat: OutputFormat | undefined,
): CliImplementerAdapter {
  const adapter = lookupCliImplementerAdapter(toolName);
  return outputFormat === undefined ? adapter : withOutputFormat(adapter, outputFormat);
}

export function createCliImplementer(
  config: CliImplementerConfig,
  options?: ImplementerFactoryOptions,
): Implementer {
  const toolName = config.tool;
  resolveCliRunnerAuth(config);
  const trustedCli: CliStartGate | undefined = options?.trustedCli;
  const registryAdapter = lookupCliImplementerAdapter(toolName);
  const descriptor = registryAdapter.descriptor;
  const command = descriptor.command;
  const notFoundMessage = cliNotFoundMessage(
    descriptor.displayName,
    descriptor.compatibility.installUrl,
  );
  const timeout = config.timeout;

  return createImplementerBase({
    extractsCode: false,
    backendKind: 'cli',
    publisher: options?.publisher,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onOutput, signal, callContext } = opts;
      const effectiveModel = resolveCliModel(config.model, toolName);
      const timeoutSignal = timeout !== undefined ? AbortSignal.timeout(timeout) : undefined;
      const composedSignal =
        signal && timeoutSignal
          ? AbortSignal.any([signal, timeoutSignal])
          : (timeoutSignal ?? signal);
      const env = opts.sandboxEnv ?? (await createRunnerSandboxEnv(projectDir, config));
      const adapter = resolveImplementerAdapter(toolName, config.outputFormat);

      try {
        let executable: CliExecutableIdentity;
        try {
          executable = (
            await resolveCliExecutableAliases({
              commands: descriptor.executableAliases,
              projectDir,
              trust: assertCliStartGate(toolName, trustedCli),
            })
          ).executable;
        } catch (err) {
          if (isCliExecutableUnavailable(err)) {
            throw processError.notFound(command, notFoundMessage);
          }
          throw err;
        }

        const configuredArgs = config.args ?? [];
        const baseArgs = adapter.baseArgs({
          prompt: CLI_PROMPT_PLACEHOLDER,
          model: effectiveModel,
          projectDir,
          configuredArgs,
        });

        const result = await invokeCliAdapter({
          adapter,
          invocation: {
            executable,
            args: [...baseArgs, ...configuredArgs],
            baseArgs,
            promptTransport: adapter.promptTransport,
            environment: toCliEnvironment(env),
            cwd: projectDir,
            timeoutMs: timeout ?? CLI_NO_DEADLINE_MS,
            signal: composedSignal,
          },
          prompt,
          callContext,
          onOutput,
          onCallEvent: opts.onCallEvent,
          idle: {
            warnMs: config.idleWarnMs,
            killMs: config.idleKillMs,
          },
        });
        if (timeout !== undefined && timeoutSignal?.aborted && !signal?.aborted) {
          throw processError.timeout({
            command: `Tool implementer (${toolName})`,
            label: `Tool implementer (${toolName})`,
            timeoutMs: timeout,
            output: result.text,
          });
        }
        return result;
      } catch (err: unknown) {
        if (timeout !== undefined && timeoutSignal?.aborted && !signal?.aborted) {
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

    ...createCommandExistsAvailability(descriptor.executableAliases),
  });
}
