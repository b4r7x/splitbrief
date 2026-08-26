import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import type { OutputFormat } from '../../core/schemas/enums.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import { createChangeDetector } from '../change-detection.js';
import { createImplementerBase } from './pipeline/run.js';
import { processError } from '../../lib/process/errors.js';
import {
  CLI_NO_DEADLINE_MS,
  invokeCliAdapter,
  toCliEnvironment,
} from '../runners/invoke-cli-adapter.js';
import { CLI_PROMPT_SENTINEL } from '../runners/cli-tools/candidate-contract.js';
import { createCommandExistsAvailability } from '../availability.js';
import { resolveCliModel } from '../../core/providers/automatic-model.js';
import { resolveCliExecutableAliases } from '../runners/resolve-cli-executable.js';
import { assertCliStartGate, type CliStartGate } from '../runners/start-gate.js';
import { matches } from '../../utils/error.js';
import { createRunnerSandboxEnv, resolveCliRunnerAuth } from '../runners/sandbox-env.js';
import { withOutputFormat } from '../runners/cli-tools/output-format.js';
import { lookupCliImplementerAdapter } from '../runners/cli-tools/registry.js';
import type { CliImplementerAdapter } from '../runners/cli-tools/contract.js';
import type { RunnerCallResult } from '../calls/types.js';
import {
  captureChangeDetectorBaseline,
  hashFiles,
  type ChangeDetectorBaseline,
} from '../change-detection.js';
import { collectTrackedFiles } from '../snapshots/files.js';
import { getCurrentChangedFiles } from '../../lib/git/files.js';
import { isInternalGitStatusPath } from '../../core/paths.js';

const isCliExecutableUnavailable = matches('cli-executable-unavailable');

function cliNotFoundMessage(displayName: string, installUrl: string): string {
  return `${displayName} not found. Install it from ${installUrl}`;
}

/**
 * The files the child changed since the baseline. Git-status diffs drop
 * internal sandbox/state paths, matching the isolation retention scan, and the
 * declared file is judged by content so a file that was already dirty before
 * the call still counts as changed; the file-hashes branch re-walks the project
 * so files created or deleted since the baseline count as changes, mirroring
 * the shared detector.
 */
async function changedFilesSince(
  projectDir: string,
  baseline: ChangeDetectorBaseline,
  declared: { file: string; hash: string | null },
): Promise<string[]> {
  if (baseline.kind === 'git-status') {
    const current = (await getCurrentChangedFiles(projectDir)).filter(
      (file) => !isInternalGitStatusPath(file),
    );
    const beforeSet = new Set(baseline.files);
    const others = current.filter((file) => !beforeSet.has(file) && file !== declared.file);
    const after = await hashFiles(projectDir, [declared.file]);
    const declaredChanged = (after[declared.file] ?? null) !== declared.hash;
    return declaredChanged ? [declared.file, ...others] : others;
  }
  const files = await collectTrackedFiles(projectDir, {
    ignoreProjectDir: baseline.ignoreProjectDir,
  });
  const after = await hashFiles(projectDir, files);
  const candidates = new Set([...Object.keys(baseline.hashes), ...files]);
  return [...candidates].filter((file) => baseline.hashes[file] !== after[file]);
}

/**
 * REQ-048 exact-effect gate: a direct-write CLI implementer succeeds only when
 * the child changed exactly the task's declared file. Nothing changed is a
 * no-staged-change failure; anything else — an unrelated file, the declared
 * file plus extras, or a wrong target — is an exact-effect failure. The
 * failure keeps the completed call's evidence (text, usage, session) while
 * carrying the stable effect code.
 */
function exactEffectFailure(
  result: RunnerCallResult,
  code: 'no-staged-change' | 'implementer-effect-invalid',
  message: string,
): RunnerCallResult {
  return { ...result, status: 'failed', error: { code, message }, partial: true };
}

function assertExactEffect(input: {
  result: RunnerCallResult;
  changed: readonly string[];
  declaredFile: string;
  label: string;
}): RunnerCallResult {
  if (input.changed.length === 0) {
    return exactEffectFailure(
      input.result,
      'no-staged-change',
      `${input.label} exited without changing any files`,
    );
  }
  if (input.changed.length !== 1 || input.changed[0] !== input.declaredFile) {
    return exactEffectFailure(
      input.result,
      'implementer-effect-invalid',
      `${input.label} changed ${input.changed.join(', ')} instead of exactly ${input.declaredFile}`,
    );
  }
  return input.result;
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
  const runnerLabel = `Tool implementer (${toolName})`;

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
      const env =
        opts.sandboxEnv ?? (await createRunnerSandboxEnv(projectDir, config, 'implementer'));
      const adapter = resolveImplementerAdapter(toolName, config.outputFormat);
      const effectBaseline = await captureChangeDetectorBaseline(projectDir);
      const declaredFileHash =
        (await hashFiles(projectDir, [opts.task.file]))[opts.task.file] ?? null;

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
          prompt: CLI_PROMPT_SENTINEL,
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
            command: runnerLabel,
            label: runnerLabel,
            timeoutMs: timeout,
            output: result.text,
          });
        }
        if (result.status === 'completed') {
          const changed = await changedFilesSince(projectDir, effectBaseline, {
            file: opts.task.file,
            hash: declaredFileHash,
          });
          return assertExactEffect({
            result,
            changed,
            declaredFile: opts.task.file,
            label: runnerLabel,
          });
        }
        return result;
      } catch (err: unknown) {
        if (timeout !== undefined && timeoutSignal?.aborted && !signal?.aborted) {
          throw processError.timeout({
            command: runnerLabel,
            label: runnerLabel,
            timeoutMs: timeout,
            output: '',
          });
        }
        throw err;
      }
    },

    detectChanges: createChangeDetector(runnerLabel),

    ...createCommandExistsAvailability(descriptor.executableAliases),
  });
}
