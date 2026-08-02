import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../core/schemas/runner-fields.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import type {
  CliImplementerAdapter,
  CliInvocation,
  CliPlannerAdapter,
} from './cli-tools/contract.js';
import { CLI_PROMPT_SENTINEL } from './cli-tools/candidate-contract.js';
import { invokeProcessCli } from './cli-tools/process-invoke.js';
import { SANDBOX_CREDENTIAL_VALUES, sandboxCredentialValues } from './sandbox-env.js';

/** The only prompt sentinel understood by the lossless CLI transport. */
export const CLI_PROMPT_PLACEHOLDER = CLI_PROMPT_SENTINEL;
/** The process executor owns explicit runner timeouts; this is its no-deadline sentinel. */
export const CLI_NO_DEADLINE_MS = 2_147_000_000;

type InvokeCliOptions = {
  adapter: CliPlannerAdapter | CliImplementerAdapter;
  invocation: CliInvocation;
  prompt: string;
  callContext: RunnerCallContext;
  onOutput?: ((text: string) => void) | undefined;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  idle?: { warnMs?: number | undefined; killMs?: number | undefined } | undefined;
};

export function toCliEnvironment(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) result[name] = value;
  }
  const credentialValues = sandboxCredentialValues(environment);
  if (credentialValues.length > 0) {
    Object.defineProperty(result, SANDBOX_CREDENTIAL_VALUES, {
      value: credentialValues,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result;
}

export async function invokeCliAdapter(opts: InvokeCliOptions): Promise<RunnerCallResult> {
  const idleWarnMs = opts.idle?.warnMs ?? RUNNER_IDLE_WARN_MS;
  const idleKillMs = opts.idle?.killMs ?? RUNNER_IDLE_KILL_MS;
  const idleController = new AbortController();
  const signal = opts.invocation.signal
    ? AbortSignal.any([opts.invocation.signal, idleController.signal])
    : idleController.signal;
  let lastActivity = Date.now();
  let warned = false;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const tickMs = Math.max(10, Math.min(100, idleWarnMs, idleKillMs));
  if (Number.isFinite(idleWarnMs) && Number.isFinite(idleKillMs)) {
    idleTimer = setInterval(() => {
      const silentMs = Date.now() - lastActivity;
      if (!warned && silentMs >= idleWarnMs) {
        warned = true;
        opts.onCallEvent?.({
          type: 'call_stalled',
          ts: Date.now(),
          ...opts.callContext,
          silentMs,
        });
      }
      if (silentMs >= idleKillMs && !idleController.signal.aborted) {
        idleController.abort(new DOMException('CLI runner idle timeout', 'TimeoutError'));
      }
    }, tickMs);
    idleTimer.unref?.();
  }

  try {
    return await invokeProcessCli(opts.adapter, {
      invocation: { ...opts.invocation, signal },
      prompt: opts.prompt,
      callContext: opts.callContext,
      onEvent: (event) => {
        if (
          event.type !== 'call_started' &&
          event.type !== 'call_completed' &&
          event.type !== 'call_error'
        ) {
          lastActivity = Date.now();
        }
        opts.onCallEvent?.(event);
        if (event.type === 'call_text_delta') opts.onOutput?.(event.text);
        if (event.type === 'call_session_id') opts.onSessionId?.(event.nativeSessionId);
      },
    });
  } finally {
    if (idleTimer !== undefined) clearInterval(idleTimer);
  }
}
