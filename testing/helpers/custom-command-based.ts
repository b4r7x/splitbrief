import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import type { CliExecutableReceipt } from '../../src/core/discovery/detection.js';
import {
  customRunnerSecurityPosture,
  resolveCustomRunnerAdmissionScope,
  type ConfiguredCustomRunner,
} from '../../src/engine/runners/custom-trust.js';
import {
  invokeCommandRunner,
  type CommandRunnerOptions,
  type CommandRunnerSource,
} from '../../src/engine/runners/command-based.js';
import type { RunnerCallEvent } from '../../src/engine/calls/types.js';
import type { AdmittedCustomRunnerInvocation } from '../../src/engine/runners/custom-launchability.js';

export function executableReceipt(path = process.execPath): CliExecutableReceipt {
  const realPath = realpathSync(path);
  const info = statSync(realPath);
  const contentDigest = createHash('sha256').update(readFileSync(realPath)).digest('hex');
  return {
    path: realPath,
    fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
    executableIdentity: {
      canonicalPath: realPath,
      realPath,
      platformFileId: `${info.dev}:${info.ino}`,
      fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:sha256:${contentDigest}`,
      resolvedAt: 0,
    },
  };
}

export function customRunner(
  opts: {
    executable?: string | undefined;
    argv?: readonly string[] | undefined;
    env?: readonly string[] | undefined;
    outputFormat?: 'text' | 'stream-json' | undefined;
    idleWarnMs?: number | undefined;
    idleKillMs?: number | undefined;
  } = {},
): ConfiguredCustomRunner {
  return {
    source: 'configured',
    command: {
      id: 'custom-test-runner',
      label: 'Custom test runner',
      contract: 'output',
      executable: opts.executable ?? process.execPath,
      argv: opts.argv ?? [],
      outputFormat: opts.outputFormat ?? 'text',
      idleWarnMs: opts.idleWarnMs ?? 1_000,
      idleKillMs: opts.idleKillMs ?? 2_000,
      env: opts.env ?? [],
    },
  };
}

export async function admittedCustomRunner(
  authorizationProjectDir: string,
  runner = customRunner(),
  executable = executableReceipt(),
  authorization: AdmittedCustomRunnerInvocation['authorization'] = 'explicit-grant',
): Promise<AdmittedCustomRunnerInvocation> {
  const posture = customRunnerSecurityPosture('implementer', runner.command.contract);
  const scope = await resolveCustomRunnerAdmissionScope({
    projectDir: authorizationProjectDir,
    runner,
    posture,
  });
  if (scope === null) throw new Error('Custom runner admission scope did not resolve');
  return {
    kind: 'custom-runner-invocation',
    runner,
    posture,
    executable,
    authorization,
    scope,
  };
}

export type CustomInvocationInput = Omit<
  Extract<CommandRunnerSource, { kind: 'admitted' }>,
  'kind'
> &
  Pick<CommandRunnerOptions, 'prompt' | 'cwd' | 'signal' | 'timeoutMs'>;

type CustomInvocationListeners = Pick<
  CommandRunnerOptions,
  'onOutput' | 'onStderr' | 'onCallEvent'
>;

/** Runs an admitted custom command the way a configured custom seat does. */
export function invokeCustomRunner(
  { prompt, cwd, signal, timeoutMs, ...source }: CustomInvocationInput,
  listeners: CustomInvocationListeners = {},
) {
  return invokeCommandRunner({
    source: { kind: 'admitted', ...source },
    prompt,
    cwd,
    callContext: { callId: 'call-custom', role: 'implementer', backendKind: 'shell' },
    signal,
    timeoutMs,
    ...listeners,
  });
}

export type CustomInvocationCallbacks = Readonly<{
  output: readonly string[];
  stderr: readonly string[];
}>;

export type CustomInvocationObservation = Readonly<{
  callbacks: CustomInvocationCallbacks;
  events: readonly RunnerCallEvent[];
  result: unknown;
  failure: unknown;
}>;

export function observableFailure(failure: unknown): unknown {
  if (failure instanceof Error || failure instanceof DOMException) {
    return {
      name: failure.name,
      message: failure.message,
      enumerable: Object.fromEntries(Object.entries(failure)),
    };
  }
  return failure;
}

export async function observeCustomInvocation(
  input: CustomInvocationInput,
  onCallback?: ((kind: 'output' | 'stderr', value: string) => void) | undefined,
): Promise<CustomInvocationObservation> {
  const callbacks: { output: string[]; stderr: string[] } = {
    output: [],
    stderr: [],
  };
  const events: RunnerCallEvent[] = [];
  let result: unknown;
  let failure: unknown;
  const recordCallback = (kind: 'output' | 'stderr', value: string) => {
    callbacks[kind].push(value);
    onCallback?.(kind, value);
  };

  try {
    result = await invokeCustomRunner(input, {
      onOutput: (value) => recordCallback('output', value),
      onStderr: (value) => recordCallback('stderr', value),
      onCallEvent: (event) => events.push(event),
    });
  } catch (error) {
    failure = error;
  }

  return { callbacks, events, result, failure };
}
