import type { SteeringPort } from '../calls/steering.js';
import { RUNNER_IDLE_WARN_MS } from '../../core/schemas/runner-fields.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import type {
  CliImplementerAdapter,
  CliInvocation,
  CliPlannerAdapter,
} from './cli-tools/contract.js';
import { onlyAddsLineBreaks, reconcileFinalText } from '../streaming/final-text.js';
import { invokeProcessCli, type ToolUseGuard } from './cli-tools/process-invoke.js';
import { SANDBOX_CREDENTIAL_VALUES, sandboxCredentialValues } from './sandbox-credential-values.js';
import { boundedRunnerCallMessage } from '../calls/status.js';

type InvokeCliOptions = {
  adapter: CliPlannerAdapter | CliImplementerAdapter;
  invocation: CliInvocation;
  prompt: string;
  steering?: SteeringPort | undefined;
  installedVersion?: string | undefined;
  callContext: RunnerCallContext;
  onOutput?: ((text: string, opts?: { messageStart?: boolean | undefined }) => void) | undefined;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  idle?: { warnMs?: number | undefined; killMs?: number | undefined } | undefined;
  toolUseGuard?: ToolUseGuard | undefined;
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

export function createCliTextForwarder(
  onOutput:
    | ((
        text: string,
        opts: Parameters<NonNullable<InvokeCliOptions['onOutput']>>[1],
        event: Extract<RunnerCallEvent, { type: 'call_text_delta' }>,
      ) => void)
    | undefined,
): (event: Extract<RunnerCallEvent, { type: 'call_text_delta' }>) => void {
  const forwardMain = createCliTextReconciler(onOutput);
  const subagents = new Map<string, ReturnType<typeof createCliTextReconciler>>();
  return (event) => {
    if (event.subagentId === undefined) {
      forwardMain(event);
      return;
    }
    let forwardSubagent = subagents.get(event.subagentId);
    if (forwardSubagent === undefined) {
      forwardSubagent = createCliTextReconciler(onOutput);
      subagents.set(event.subagentId, forwardSubagent);
    }
    forwardSubagent(event);
  };
}

function createCliTextReconciler(
  onOutput: Parameters<typeof createCliTextForwarder>[0],
): ReturnType<typeof createCliTextForwarder> {
  let streamedText = '';
  let blockText = '';
  let nextAssistantStartsMessage = false;
  const stream = (
    text: string,
    event: Extract<RunnerCallEvent, { type: 'call_text_delta' }>,
  ): void => {
    if (text.length === 0) return;
    streamedText += text;
    blockText += text;
    const messageStart = event.channel === 'assistant' && nextAssistantStartsMessage;
    onOutput?.(text, { messageStart }, event);
    if (messageStart) nextAssistantStartsMessage = false;
  };
  const forwardText = (event: Extract<RunnerCallEvent, { type: 'call_text_delta' }>): void => {
    if (!contributesToStreamedText(event.channel)) {
      onOutput?.(event.text, undefined, event);
      return;
    }
    if (event.semantics !== 'final') {
      stream(event.text, event);
      return;
    }
    // `final` text restates rather than extends: an assistant record restates
    // the block its partial deltas already streamed, and the terminal result
    // restates the whole message. Only the part never streamed is new.
    const alreadyStreamed = event.channel === 'result' ? streamedText : blockText;
    const reconciliation = reconcileFinalText(alreadyStreamed, event.text);
    if (reconciliation.kind === 'full' || reconciliation.kind === 'suffix') {
      stream(reconciliation.text, event);
    } else if (reconciliation.kind === 'replace') {
      if (event.channel === 'result') {
        if (streamedText.endsWith(reconciliation.text)) return;
        // A final group that only puts its streamed messages on their own lines is not new text.
        if (onlyAddsLineBreaks(streamedText, reconciliation.text)) return;
        if (reconciliation.text.startsWith(streamedText)) {
          const tail = reconciliation.text.slice(streamedText.length);
          streamedText = reconciliation.text;
          if (tail.length > 0) onOutput?.(tail, undefined, event);
        } else {
          streamedText = reconciliation.text;
          onOutput?.(reconciliation.text, undefined, event);
        }
      } else {
        blockText = '';
        stream(reconciliation.text, event);
      }
    }
    if (event.channel !== 'result') blockText = '';
  };

  return (event) => {
    forwardText(event);
    // A final assistant record closes one message after reconciling its streamed deltas.
    // Only the next assistant text starts a new transcript row.
    if (event.channel === 'assistant' && event.semantics === 'final') {
      nextAssistantStartsMessage = true;
    }
  };
}

export async function invokeCliAdapter(opts: InvokeCliOptions): Promise<RunnerCallResult> {
  const forwardText = createCliTextForwarder((text, outputOpts, event) => {
    opts.onOutput?.(text, outputOpts);
    if (event.subagentId !== undefined) {
      opts.onCallEvent?.({ ...event, text, semantics: 'delta' });
    }
  });
  let stderr = '';
  const redactProcessPath = (text: string): string =>
    text.replaceAll(opts.invocation.executable.path, opts.adapter.descriptor.command);
  const failure = (detail: NonNullable<RunnerCallResult['error']>) => ({
    ...detail,
    message: boundedRunnerCallMessage(
      redactProcessPath(
        detail.code === 'non-zero-exit' && stderr.trim().length > 0
          ? `${detail.message}: ${stderr.trim()}`
          : detail.message,
      ),
    ),
  });

  const result = await invokeProcessCli(opts.adapter, {
    invocation: opts.invocation,
    prompt: opts.prompt,
    steering: opts.steering,
    installedVersion: opts.installedVersion,
    callContext: opts.callContext,
    idle: {
      warnMs: opts.idle?.warnMs ?? RUNNER_IDLE_WARN_MS,
      killMs: opts.idle?.killMs,
    },
    toolUseGuard: opts.toolUseGuard,
    onEvent: (rawEvent) => {
      const event: RunnerCallEvent =
        rawEvent.type === 'call_stderr_delta'
          ? { ...rawEvent, text: redactProcessPath(rawEvent.text) }
          : rawEvent.type === 'call_warning'
            ? {
                ...rawEvent,
                warning: {
                  ...rawEvent.warning,
                  message: redactProcessPath(rawEvent.warning.message),
                },
              }
            : rawEvent.type === 'call_error'
              ? {
                  ...rawEvent,
                  error: failure(rawEvent.error),
                  ...(rawEvent.rawTail !== undefined && {
                    rawTail: redactProcessPath(rawEvent.rawTail),
                  }),
                }
              : rawEvent;
      if (event.type === 'call_stderr_delta') stderr = `${stderr}${event.text}`.slice(-8_192);
      if (event.type === 'call_text_delta' && event.subagentId !== undefined) {
        forwardText(event);
        return;
      }
      opts.onCallEvent?.(event);
      if (event.type === 'call_text_delta') {
        forwardText(event);
      }
      if (event.type === 'call_session_id') opts.onSessionId?.(event.nativeSessionId);
    },
  });
  const warnings = result.warnings.map((warning) => ({
    ...warning,
    message: redactProcessPath(warning.message),
  }));
  return result.status === 'completed'
    ? { ...result, warnings }
    : { ...result, error: failure(result.error), warnings };
}

function contributesToStreamedText(
  channel: Extract<RunnerCallEvent, { type: 'call_text_delta' }>['channel'],
): boolean {
  return channel === 'assistant' || channel === 'result' || channel === 'stdout';
}
