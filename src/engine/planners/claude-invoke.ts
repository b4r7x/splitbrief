import type { Attachment } from '../../core/schemas/attachment.js';
import type { CliAuthChannelId } from '../../core/runners/cli-tool-catalog.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { RunnerAttemptCallbacks } from '../calls/callback-buffer.js';
import type { SteeringPort } from '../calls/steering.js';
import type { RunnerCallContext, RunnerCallResult } from '../calls/types.js';
import {
  createRunnerCallCredentialRedactor,
  runnerCallInterruptedStatus,
  type RunnerCallCredentialRedactor,
} from '../calls/status.js';
import { parseStreamLine } from '../streaming/parse-stream-json.js';
import { buildClaudeArgs } from '../runners/claude/args.js';
import { claudeCredentialValues } from '../runners/claude/child-env.js';
import { claudeCodePlannerAdapter } from '../runners/cli-tools/claude-code.js';
import type { CliProtocolEvent, CliSchemaInput } from '../runners/cli-tools/contract.js';
import { invokeCliAdapter, toCliEnvironment } from '../runners/invoke-cli-adapter.js';
import { withCliInvocationIdentity } from '../runners/invocation-identity.js';
import { resolveCliExecutable } from '../runners/resolve-cli-executable.js';
import { assertCliStartGate } from '../runners/start-gate.js';
import { error } from '../../utils/error.js';
import { isSessionExpiredError, sessionResumeExpiredError } from '../session-expiry.js';

export async function invokeClaudePlanner(opts: {
  prompt: string;
  projectDir: string;
  sessionId: string | null;
  callbacks: RunnerAttemptCallbacks & {
    steering?: SteeringPort | undefined;
    onSessionInit?: ((id: string) => void) | undefined;
  };
  callContext: RunnerCallContext;
  env: NodeJS.ProcessEnv;
  trustedCli?:
    | { executable: CliExecutableIdentity; installedVersion?: string | undefined }
    | undefined;
  model?: string | undefined;
  authChannel: CliAuthChannelId;
  configuredAuthChannel: CliAuthChannelId | undefined;
  effort?: EffortLevel | undefined;
  configuredArgs?: readonly string[] | undefined;
  skillRoots?: readonly string[] | undefined;
  images?: readonly Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
  schema?: CliSchemaInput | undefined;
}): Promise<RunnerCallResult> {
  const args = buildClaudeArgs(opts);
  const executable = await resolveCliExecutable({
    command: 'claude',
    projectDir: opts.projectDir,
    trust: assertCliStartGate(
      'claude-code',
      opts.trustedCli === undefined ? undefined : { tool: 'claude-code', ...opts.trustedCli },
    ),
  });
  const redact = createRunnerCallCredentialRedactor(
    claudeCredentialValues(opts.authChannel, opts.env),
  );
  const observeInit = (parse: (line: string) => readonly CliProtocolEvent[]) => (line: string) => {
    const parsed = parseStreamLine(line);
    if (parsed.isSessionInit && parsed.sessionId !== undefined)
      opts.callbacks.onSessionInit?.(redact(parsed.sessionId));
    return parse(line);
  };
  const adapter = claudeCodePlannerAdapter;
  const steering = adapter.steering;
  let stderr = '';
  const result = await invokeCliAdapter({
    adapter: {
      ...adapter,
      createParser: () => observeInit(adapter.createParser?.() ?? adapter.parse),
      ...(steering !== undefined && {
        steering: {
          ...steering,
          open: async (input) => {
            const transport = await steering.open(input);
            return { ...transport, parse: observeInit(transport.parse) };
          },
        },
      }),
    },
    invocation: {
      executable,
      args,
      baseArgs: args.slice(0, args.length - (opts.configuredArgs?.length ?? 0)),
      promptTransport: adapter.promptTransport,
      environment: toCliEnvironment(opts.env),
      cwd: opts.projectDir,
      images: opts.images,
      signal: opts.signal,
    },
    prompt: opts.prompt,
    steering: opts.callbacks.steering,
    installedVersion: opts.trustedCli?.installedVersion,
    callContext: withCliInvocationIdentity({
      runner: { kind: 'cli', tool: 'claude-code', authChannel: opts.configuredAuthChannel },
      callContext: opts.callContext,
      executable,
    }),
    onOutput: opts.callbacks.onOutput,
    onSessionId: opts.callbacks.onSessionId,
    onCallEvent: (event) => {
      if (event.type === 'call_stderr_delta') stderr = `${stderr}${event.text}`.slice(-8_192);
      opts.callbacks.onCallEvent?.(event);
    },
    idle: { warnMs: opts.idleWarnMs, killMs: opts.idleKillMs },
  });
  if (result.status !== 'completed') {
    const failureText = `${result.error?.message ?? result.text}\n${stderr}`;
    if (opts.sessionId !== null && isSessionExpiredError(failureText)) {
      throw sessionResumeExpiredError(opts.sessionId, failureText);
    }
    throwForClaudeCallFailure(result, opts.signal, redact);
  }
  return { ...result, nativeSessionId: result.nativeSessionId ?? opts.sessionId };
}

function throwForClaudeCallFailure(
  result: RunnerCallResult,
  signal?: AbortSignal | undefined,
  redact?: RunnerCallCredentialRedactor | undefined,
): never {
  const detail = result.error?.message;
  const message =
    detail !== undefined && detail.length > 0
      ? `Claude runner call ${result.status}: ${detail}`
      : `Claude runner call ${result.status}`;
  const failure = error('runner-call-failed', message, {
    callId: result.callId,
    status: result.status,
    output: result.text,
    nativeSessionId: result.nativeSessionId,
    partial: result.partial,
    error: result.error,
  });
  throw interruptedError(signal, failure, redact);
}

export function interruptedError(
  signal: AbortSignal | undefined,
  fallback: unknown,
  redact?: RunnerCallCredentialRedactor,
): unknown {
  if (!signal?.aborted) return fallback;
  if (!(signal.reason instanceof Error) || redact === undefined) {
    return signal.reason instanceof Error ? signal.reason : fallback;
  }
  const safeReason = error('runner-interrupted', redact(signal.reason.message), {
    status: runnerCallInterruptedStatus(signal),
    name: signal.reason.name,
  });
  safeReason.name = signal.reason.name;
  return safeReason;
}
