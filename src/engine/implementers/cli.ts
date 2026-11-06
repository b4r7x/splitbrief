import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { OutputFormat } from '../../core/schemas/enums.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import {
  captureChangeDetectorBaseline,
  createChangeDetector,
  summarizeChanges,
} from '../change-detection.js';
import { createImplementerBase } from './pipeline/run.js';
import { invokeCliAdapter, toCliEnvironment } from '../runners/invoke-cli-adapter.js';
import { createCommandExistsAvailability } from '../availability.js';
import { resolveCliModel } from '../../core/providers/automatic-model.js';
import { callAdmittedCli, requireCliSeat } from '../runners/start-gate.js';
import { createRunnerSandboxEnv, resolveCliRunnerAuth } from '../runners/sandbox-env.js';
import { withOutputFormat } from '../runners/cli-tools/output-format.js';
import { withCliInvocationIdentity } from '../runners/invocation-identity.js';
import { lookupCliImplementerAdapter } from '../runners/cli-tools/registry.js';
import type { CliImplementerAdapter } from '../runners/cli-tools/contract.js';
import type { RunnerCallResult } from '../calls/types.js';
import type { Task } from '../../core/schemas/task.js';
import { undeclaredFiles } from '../../core/scope/declared-set.js';
import { stderrUsageLimit } from '../runners/usage-limit.js';
import {
  createIsolationBoundary,
  formatIsolationBreach,
  isolationToolUseGuard,
} from './isolation/boundary.js';

/**
 * REQ-016 declared-effect gate: a direct-write CLI implementer succeeds when
 * the child changed something. Nothing changed is a no-staged-change failure,
 * except in an attempt allowed to change nothing (a fix task, or a continued
 * cut attempt, whose work is already on disk). A write outside the brief's
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
  const cliSeat = options?.cliSeat;
  const registryAdapter = lookupCliImplementerAdapter(toolName);
  const descriptor = registryAdapter.descriptor;
  const runnerLabel = descriptor.displayName;

  return createImplementerBase({
    extractsCode: false,
    backendKind: 'cli',
    publisher: options?.publisher,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onOutput, signal, callContext } = opts;
      const effectiveModel = resolveCliModel(config.model, toolName);
      const env =
        opts.sandboxEnv ?? (await createRunnerSandboxEnv(projectDir, config, 'implementer'));
      const adapter = resolveImplementerAdapter(toolName, config.outputFormat);
      const effectBaseline = await captureChangeDetectorBaseline(projectDir, {
        kind: opts.changeDetection,
        ignoreProjectDir: opts.checkoutDir,
      });
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

      const configuredArgs = config.args ?? [];
      const result = await callAdmittedCli(
        requireCliSeat(toolName, cliSeat),
        signal,
        (executable, gate) => {
          const baseArgs = adapter.baseArgs({
            model: effectiveModel,
            projectDir,
            configuredArgs,
            effort: config.effort,
            variant: config.variant,
            installedVersion: gate.installedVersion,
            skillRoots: opts.skillRoots,
            imagePaths: opts.images?.map((image) => image.path),
          });
          return invokeCliAdapter({
            adapter,
            invocation: {
              executable,
              args: [...baseArgs, ...configuredArgs],
              baseArgs,
              promptTransport: adapter.promptTransport,
              environment: toCliEnvironment(env),
              cwd: projectDir,
              images: opts.images,
              timeoutMs: config.timeout,
              signal,
            },
            prompt,
            steering: opts.steering,
            installedVersion: gate.installedVersion,
            callContext: withCliInvocationIdentity({ runner: config, callContext, executable }),
            onOutput,
            onCallEvent: opts.onCallEvent,
            idle: {
              warnMs: config.idleWarnMs,
              killMs: config.idleKillMs,
            },
            maxToolCalls: config.maxToolCalls,
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
        },
      );
      if (result.status === 'completed') {
        return assertDeclaredEffect({
          result,
          changed: (await summarizeChanges(projectDir, effectBaseline)).files,
          task: opts.task,
          label: runnerLabel,
          undeclaredWrites: opts.undeclaredWrites ?? 'gate',
          allowNoChange: opts.allowNoChange === true,
        });
      }
      return result;
    },

    detectChanges: createChangeDetector(runnerLabel),

    ...createCommandExistsAvailability(descriptor.executableAliases),
  });
}
