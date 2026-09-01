import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../core/schemas/runner-fields.js';
import {
  createTaskCompilationAttemptId,
  type TaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
} from '../../core/schemas/task-compilation.js';
import type { DispatchClaim, TaskDispatchLedger } from '../calls/dispatch-ledger.js';
import { createRunnerCallRecorder } from '../calls/recorder.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import type {
  CliImplementerAdapter,
  CliInvocation,
  CliPlannerAdapter,
} from './cli-tools/contract.js';
import { reconcileFinalText } from '../streaming/final-text.js';
import { invokeProcessCli } from './cli-tools/process-invoke.js';
import { SANDBOX_CREDENTIAL_VALUES, sandboxCredentialValues } from './sandbox-credential-values.js';

/** The process executor owns explicit runner timeouts; this is its no-deadline sentinel. */
export const CLI_NO_DEADLINE_MS = 2_147_000_000;

type InvokeCliOptions = {
  adapter: CliPlannerAdapter | CliImplementerAdapter;
  invocation: CliInvocation;
  prompt: string;
  callContext: RunnerCallContext;
  /** Operation-wide claim port: one claim is taken immediately before the physical invoke. */
  ledger?: TaskDispatchLedger | undefined;
  attemptId?: TaskCompilationAttemptId | undefined;
  envelope?: TaskCompilationCallEnvelope | undefined;
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
  if (opts.ledger === undefined && opts.attemptId === undefined && opts.envelope === undefined) {
    return invokePreparedCli(opts);
  }
  const attemptId =
    opts.attemptId ?? opts.callContext.attemptId ?? createTaskCompilationAttemptId();
  const callContext: RunnerCallContext = {
    ...opts.callContext,
    attemptId,
    ...(opts.envelope !== undefined && { envelope: opts.envelope }),
  };
  if (opts.ledger !== undefined) {
    const claim = opts.ledger.claimDispatch(attemptId);
    if (claim.kind === 'refused') {
      return createRunnerCallRecorder({ context: callContext }).finishFailed({
        status: 'refused',
        error: {
          code: 'task_compiler_dispatch_limit',
          message: dispatchRefusalMessage(claim),
        },
      });
    }
  }
  return invokePreparedCli({ ...opts, callContext });
}

async function invokePreparedCli(opts: InvokeCliOptions): Promise<RunnerCallResult> {
  let streamedText = '';
  let blockText = '';
  const stream = (text: string): void => {
    if (text.length === 0) return;
    streamedText += text;
    blockText += text;
    opts.onOutput?.(text);
  };
  const forwardText = (event: Extract<RunnerCallEvent, { type: 'call_text_delta' }>): void => {
    if (!contributesToStreamedText(event.channel)) {
      opts.onOutput?.(event.text);
      return;
    }
    if (event.semantics !== 'final') {
      stream(event.text);
      return;
    }
    // `final` text restates rather than extends: an assistant record restates
    // the block its partial deltas already streamed, and the terminal result
    // restates the whole message. Only the part never streamed is new.
    const alreadyStreamed = event.channel === 'result' ? streamedText : blockText;
    const reconciliation = reconcileFinalText(alreadyStreamed, event.text);
    if (reconciliation.kind === 'full' || reconciliation.kind === 'suffix') {
      stream(reconciliation.text);
    } else if (reconciliation.kind === 'replace') {
      if (event.channel === 'result') {
        if (streamedText.endsWith(reconciliation.text)) return;
        if (reconciliation.text.startsWith(streamedText)) {
          const tail = reconciliation.text.slice(streamedText.length);
          streamedText = reconciliation.text;
          if (tail.length > 0) opts.onOutput?.(tail);
        } else {
          streamedText = reconciliation.text;
          opts.onOutput?.(reconciliation.text);
        }
      } else {
        blockText = '';
        stream(reconciliation.text);
      }
    }
    if (event.channel !== 'result') blockText = '';
  };

  return invokeProcessCli(opts.adapter, {
    invocation: opts.invocation,
    prompt: opts.prompt,
    callContext: opts.callContext,
    idle: {
      warnMs: opts.idle?.warnMs ?? RUNNER_IDLE_WARN_MS,
      killMs: opts.idle?.killMs ?? RUNNER_IDLE_KILL_MS,
    },
    onEvent: (event) => {
      opts.onCallEvent?.(event);
      if (event.type === 'call_text_delta') forwardText(event);
      if (event.type === 'call_session_id') opts.onSessionId?.(event.nativeSessionId);
    },
  });
}

function dispatchRefusalMessage(claim: Extract<DispatchClaim, { kind: 'refused' }>): string {
  switch (claim.reason) {
    case 'dispatch-limit':
      return `operation dispatch limit reached (${claim.dispatchCount}/${claim.dispatchLimit})`;
    case 'attempt-already-claimed':
      return `attempt ${claim.attemptId} already claimed; refusing replay`;
    case 'invalid-attempt-id':
      return `attempt id ${claim.attemptId} is invalid; refusing dispatch`;
  }
}

function contributesToStreamedText(
  channel: Extract<RunnerCallEvent, { type: 'call_text_delta' }>['channel'],
): boolean {
  return channel === 'assistant' || channel === 'result' || channel === 'stdout';
}
