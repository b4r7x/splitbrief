import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import type { OutputFormat } from '../../core/schemas/enums.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import { createChangeDetector } from '../change-detection.js';
import { createImplementerBase } from './pipeline/run.js';
import { processError } from '../../lib/process/errors.js';
import { invokeCliAdapter, toCliEnvironment } from '../runners/invoke-cli-adapter.js';
import { CLI_PROMPT_SENTINEL } from '../runners/cli-tools/candidate-contract.js';
import { createCommandExistsAvailability } from '../availability.js';
import { resolveCliModel } from '../../core/providers/automatic-model.js';
import { resolveCliExecutableAliases } from '../runners/resolve-cli-executable.js';
import { assertCliStartGate, type CliStartGate } from '../runners/start-gate.js';
import { matches } from '../../utils/error.js';
import { createRunnerSandboxEnv, resolveCliRunnerAuth } from '../runners/sandbox-env.js';
import { withOutputFormat } from '../runners/cli-tools/output-format.js';
import { withCliInvocationIdentity } from '../runners/invocation-identity.js';
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
import type { Task } from '../../core/schemas/task.js';
import { undeclaredFiles } from '../../core/scope/declared-set.js';
import { stderrUsageLimit } from '../runners/usage-limit.js';
import {
  createIsolationBoundary,
  formatIsolationBreach,
  isolationToolUseGuard,
} from './isolation/boundary.js';

const isCliExecutableUnavailable = matches('cli-executable-unavailable');

function cliNotFoundMessage(displayName: string, installUrl: string): string {
  return `${displayName} not found. Install it from ${installUrl}`;
}

/**
 * The files the child changed since the baseline. Git-status diffs drop
 * internal sandbox/state paths, matching the isolation retention scan, and the
 * declared files are judged by content so a file that was already dirty before
 * the call still counts as changed; the file-hashes branch re-walks the project
 * so files created or deleted since the baseline count as changes, mirroring
 * the shared detector.
 */
async function changedFilesSince(
  projectDir: string,
  baseline: ChangeDetectorBaseline,
  declared: { files: readonly string[]; hashes: Record<string, string | null> },
): Promise<string[]> {
  if (baseline.kind === 'git-status') {
    const current = (await getCurrentChangedFiles(projectDir)).filter(
      (file) => !isInternalGitStatusPath(file),
    );
    const beforeSet = new Set(baseline.files);
    const declaredSet = new Set(declared.files);
    const others = current.filter((file) => !beforeSet.has(file) && !declaredSet.has(file));
    const after = await hashFiles(projectDir, [...declared.files]);
    const changedDeclared = declared.files.filter(
      (file) => (after[file] ?? null) !== declared.hashes[file],
    );
    return [...changedDeclared, ...others];
  }
  const files = await collectTrackedFiles(projectDir, {
    ignoreProjectDir: baseline.ignoreProjectDir,
  });
  const after = await hashFiles(projectDir, files);
  const candidates = new Set([...Object.keys(baseline.hashes), ...files]);
  return [...candidates].filter((file) => baseline.hashes[file] !== after[file]);
}

/**
 * REQ-016 declared-effect gate: a direct-write CLI implementer succeeds when
 * the child changed something. Nothing changed is a no-staged-change failure,
 * except in an attempt allowed to change nothing (a fix task whose work
 * is already on disk). A write outside the brief's
 * declared set — its `files` plus the paths its Scope names under In bounds or
 * Approved out of bounds — goes to the orchestrator's approval gate, unless the
 * caller rejects it here (the conformance harness). A child that changed nothing after
 * printing a usage limit on stderr is out of quota, not idle — antigravity
 * exits 0 with "(response may be truncated)" the first time its quota trips —
 * so the limit outranks the empty effect, the allowance included, and the
 * ladder halts instead of retrying into it. The failure
 * keeps the completed call's evidence (text, usage, session) while carrying
 * the stable code.
 */
function declaredEffectFailure(
  result: RunnerCallResult,
  code: 'no-staged-change' | 'implementer-effect-invalid' | 'usage-limit',
  message: string,
): RunnerCallResult {
  return { ...result, status: 'failed', error: { code, message }, partial: true };
}

function assertDeclaredEffect(input: {
  result: RunnerCallResult;
  changed: readonly string[];
  task: Task;
  label: string;
  undeclaredWrites: 'reject' | 'gate';
  allowNoChange: boolean;
}): RunnerCallResult {
  if (input.changed.length === 0) {
    const limit = stderrUsageLimit(input.result.warnings);
    if (limit !== undefined) {
      return declaredEffectFailure(input.result, 'usage-limit', limit);
    }
    if (input.allowNoChange) return input.result;
    return declaredEffectFailure(
      input.result,
      'no-staged-change',
      `${input.label} exited without changing any files`,
    );
  }
  const undeclared =
    input.undeclaredWrites === 'reject' ? undeclaredFiles(input.changed, input.task) : [];
  if (undeclared.length > 0) {
    return declaredEffectFailure(
      input.result,
      'implementer-effect-invalid',
      `${input.label} wrote outside the brief's declared files: ${undeclared.join(', ')}`,
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
  const deadlineMs = config.timeout;
  const runnerLabel = `Tool implementer (${toolName})`;

  return createImplementerBase({
    extractsCode: false,
    backendKind: 'cli',
    publisher: options?.publisher,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onOutput, signal, callContext } = opts;
      const effectiveModel = resolveCliModel(config.model, toolName);
      const timeoutSignal: AbortSignal | undefined =
        deadlineMs === undefined ? undefined : AbortSignal.timeout(deadlineMs);
      const composedSignal =
        timeoutSignal === undefined
          ? signal
          : signal
            ? AbortSignal.any([signal, timeoutSignal])
            : timeoutSignal;
      const env =
        opts.sandboxEnv ?? (await createRunnerSandboxEnv(projectDir, config, 'implementer'));
      const adapter = resolveImplementerAdapter(toolName, config.outputFormat);
      const effectBaseline = await captureChangeDetectorBaseline(projectDir, {
        kind: opts.changeDetection,
        ignoreProjectDir: opts.checkoutDir,
      });
      const declaredPaths = [...opts.task.suggestedFiles];
      const declaredHashes = await hashFiles(projectDir, declaredPaths);
      const boundary =
        opts.checkoutDir === undefined
          ? undefined
          : createIsolationBoundary({
              isolationDir: projectDir,
              checkoutDir: opts.checkoutDir,
              env,
              tool: toolName,
              ...(opts.skillRoots !== undefined && { skillRoots: opts.skillRoots }),
            });

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
          effort: config.effort,
          variant: config.variant,
          installedVersion: trustedCli?.installedVersion,
          skillRoots: opts.skillRoots,
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
            timeoutMs: deadlineMs,
            signal: composedSignal,
          },
          prompt,
          callContext: withCliInvocationIdentity({ runner: config, callContext, executable }),
          onOutput,
          onCallEvent: opts.onCallEvent,
          idle: {
            warnMs: config.idleWarnMs,
            killMs: config.idleKillMs,
          },
          toolUseGuard:
            boundary === undefined
              ? undefined
              : isolationToolUseGuard(boundary, {
                  onOutsideRead: (breach) => {
                    if (opts.phase === undefined) return;
                    options?.publisher?.publishWarning({
                      phase: opts.phase,
                      taskId: opts.task.id,
                      message: `Task ${opts.task.id} ${formatIsolationBreach(breach)}`,
                      safety: { category: 'implementer', code: 'isolation_outside_read' },
                    });
                  },
                }),
        });
        if (timeoutSignal?.aborted === true && !signal?.aborted && deadlineMs !== undefined) {
          throw processError.timeout({
            command: runnerLabel,
            label: runnerLabel,
            timeoutMs: deadlineMs,
            output: result.text,
          });
        }
        if (result.status === 'completed') {
          const changed = await changedFilesSince(projectDir, effectBaseline, {
            files: declaredPaths,
            hashes: declaredHashes,
          });
          return assertDeclaredEffect({
            result,
            changed,
            task: opts.task,
            label: runnerLabel,
            undeclaredWrites: opts.undeclaredWrites ?? 'gate',
            allowNoChange: opts.allowNoChange === true,
          });
        }
        return result;
      } catch (err: unknown) {
        if (timeoutSignal?.aborted === true && !signal?.aborted && deadlineMs !== undefined) {
          throw processError.timeout({
            command: runnerLabel,
            label: runnerLabel,
            timeoutMs: deadlineMs,
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
