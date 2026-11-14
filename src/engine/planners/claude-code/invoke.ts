import type { Attachment } from '../../../core/schemas/attachment.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { RunnerAttemptCallbacks } from '../../calls/callback-buffer.js';
import type { SteeringPort } from '../../calls/steering.js';
import type { RunnerCallContext, RunnerCallResult } from '../../calls/types.js';
import {
  createRunnerCallCredentialRedactor,
  runnerCallInterruptedStatus,
  type RunnerCallCredentialRedactor,
} from '../../calls/status.js';
import { parseStreamLine } from '../../streaming/parse/stream-json/line.js';
import { buildClaudeArgs } from './args.js';
import { claudeCodePlannerAdapter } from '../../runners/cli-tools/claude-code/adapter.js';
import type { CliProtocolEvent, CliSchemaInput } from '../../runners/cli-tools/contract.js';
import { invokeCliAdapter, toCliEnvironment } from '../../runners/invoke-cli-adapter.js';
import { sandboxCredentialValues } from '../../runners/sandbox/credential-values.js';
import { withCliInvocationIdentity } from '../../runners/invocation-identity.js';
import { callAdmittedCli, requireCliSeat, type CliSeat } from '../../runners/seat-gates.js';
import { error } from '../../../utils/error.js';
import { isSessionExpiredError, sessionResumeExpiredError } from '../../session-expiry.js';

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
  cliSeat?: CliSeat | undefined;
  model?: string | undefined;
  effort?: EffortLevel | undefined;
  configuredArgs?: readonly string[] | undefined;
  skillRoots?: readonly string[] | undefined;
  images?: readonly Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
  maxToolCalls?: number | undefined;
  schema?: CliSchemaInput | undefined;
}): Promise<RunnerCallResult> {
  const args = buildClaudeArgs(opts);
  const redact = createRunnerCallCredentialRedactor(sandboxCredentialValues(opts.env));
  const observeInit = (parse: (line: string) => readonly CliProtocolEvent[]) => (line: string) => {
    const parsed = parseStreamLine(line);
    if (parsed.isSessionInit && parsed.sessionId !== undefined)
      opts.callbacks.onSessionInit?.(redact(parsed.sessionId));
    return parse(line);
  };
  const adapter = claudeCodePlannerAdapter;
  const steering = adapter.steering;
  let stderr = '';
  const result = await callAdmittedCli(
    requireCliSeat('claude-code', opts.cliSeat),
    opts.signal,
    (executable, gate) =>
      invokeCliAdapter({
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
          timeoutMs: opts.timeoutMs,
          signal: opts.signal,
        },
        prompt: opts.prompt,
        steering: opts.callbacks.steering,
        installedVersion: gate.installedVersion,
        callContext: withCliInvocationIdentity({
          tool: 'claude-code',
          callContext: opts.callContext,
        }),
        onOutput: opts.callbacks.onOutput,
        onSessionId: opts.callbacks.onSessionId,
        onCallEvent: (event) => {
          if (event.type === 'call_stderr_delta') stderr = `${stderr}${event.text}`.slice(-8_192);
          opts.callbacks.onCallEvent?.(event);
        },
        idle: { warnMs: opts.idleWarnMs, killMs: opts.idleKillMs },
        maxToolCalls: opts.maxToolCalls,
      }),
  );
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
