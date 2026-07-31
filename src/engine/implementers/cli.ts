import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import { createChangeDetector } from '../change-detection.js';
import { createImplementerBase } from './pipeline/run.js';
import { parseTextLine } from '../streaming/parse-text.js';
import { getLineParser } from '../streaming/output-parsers.js';
import { processError } from '../../lib/process/errors.js';
import {
  CLI_NO_DEADLINE_MS,
  CLI_PROMPT_PLACEHOLDER,
  CLI_TOOLS,
  createCliImplementerAdapter,
  invokeCliAdapter,
  toCliEnvironment,
} from '../runners/cli-tools.js';
import { createCommandExistsAvailability } from '../availability.js';
import { runClaudeOneShot } from '../runners/claude/invoke.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { runnerConfigError } from '../runners/errors.js';
import { resolveCliExecutable } from '../runners/resolve-cli-executable.js';
import { assertCliStartGate, type CliStartGate } from '../runners/start-gate.js';
import { matches } from '../../utils/error.js';
import { createRunnerSandboxEnv, resolveCliRunnerAuth } from '../runners/sandbox-env.js';

const isCliExecutableUnavailable = matches('cli-executable-unavailable');

export function createCliImplementer(
  config: CliImplementerConfig,
  options?: ImplementerFactoryOptions,
): Implementer {
  const toolName = config.tool;
  resolveCliRunnerAuth(config);
  const trustedCli: CliStartGate | undefined = options?.trustedCli;
  const tool = CLI_TOOLS[toolName];
  const timeout = config.timeout;

  return createImplementerBase({
    extractsCode: false,
    backendKind: 'cli',
    publisher: options?.publisher,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onOutput, signal, callContext } = opts;
      const effectiveModel = resolveAutoModel(config.model, toolName);
      const timeoutSignal = timeout !== undefined ? AbortSignal.timeout(timeout) : undefined;
      const composedSignal =
        signal && timeoutSignal
          ? AbortSignal.any([signal, timeoutSignal])
          : (timeoutSignal ?? signal);
      const env = opts.sandboxEnv ?? (await createRunnerSandboxEnv(projectDir, config));

      try {
        if (toolName === 'claude-code') {
          const trustedExecutable = assertCliStartGate(toolName, trustedCli);
          return await runClaudeOneShot({
            prompt,
            projectDir,
            onOutput,
            onCallEvent: opts.onCallEvent,
            callContext,
            model: effectiveModel,
            authChannel: config.authChannel,
            permissionMode: 'acceptEdits',
            signal: composedSignal,
            env,
            executable: trustedExecutable,
            idleWarnMs: config.idleWarnMs,
            idleKillMs: config.idleKillMs,
          });
        }

        if (!tool.implementer) throw runnerConfigError.missingToolConfig(toolName, 'implementer');
        let executable: Awaited<ReturnType<typeof resolveCliExecutable>>;
        try {
          executable = await resolveCliExecutable(
            tool.command,
            projectDir,
            assertCliStartGate(toolName, trustedCli),
          );
        } catch (err) {
          if (isCliExecutableUnavailable(err)) {
            throw processError.notFound(tool.command, tool.notFoundMessage);
          }
          throw err;
        }
        const parseLine = config.outputFormat
          ? getLineParser(config.outputFormat)
          : (tool.implementer.parseLine ?? parseTextLine);
        // Build through the adapter with one standalone sentinel. The executor
        // replaces it losslessly (or rejects an over-limit argv before spawn).
        const adapter = createCliImplementerAdapter({
          toolName,
          implementer: tool.implementer,
          parseLine,
        });
        const args = adapter.buildArgs({
          prompt: CLI_PROMPT_PLACEHOLDER,
          model: effectiveModel,
          projectDir,
          configuredArgs: config.args ?? [],
        });

        const result = await invokeCliAdapter({
          adapter,
          invocation: {
            executable,
            args,
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

    ...createCommandExistsAvailability(tool.command),
  });
}
