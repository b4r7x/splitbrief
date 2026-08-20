import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { accumulateTokenUsage, toTokenDelta } from '../../calls/usage.js';
import { reconcileFinalText } from '../../streaming/final-text.js';
import { error } from '../../../utils/error.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { processError } from '../../../lib/process/errors.js';
import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../../core/schemas/runner-fields.js';
import { createRunnerCallRecorder } from '../../calls/recorder.js';
import {
  runnerCallErrorFromUnknown,
  runnerCallIdleTimeoutError,
  runnerCallInterruptedStatus,
} from '../../calls/status.js';
import {
  createRunnerCallDeltaLimiter,
  finishRunnerCallOutputLimit,
  type RunnerCallDeltaLimitResult,
} from '../../calls/output-limit.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../../calls/types.js';
import {
  decodeSdkMessage,
  extractResultText,
  isSdkResultFailure,
  sdkFailureStatus,
  sdkResultErrorMessage,
} from './protocol.js';
import { createIdleWatchdog } from './idle-watchdog.js';
import { extractAssistantText, extractToolUses, recordInvalidSdkPayload } from './blocks.js';

type StreamResult = RunnerCallResult & { sessionId?: string | null };

const ENVELOPE_LIMIT_CODES: ReadonlySet<string> = new Set([
  'task_compiler_output_limited',
  'task_compiler_timeout',
]);

export interface ProcessStreamOptions {
  stream: AsyncIterable<unknown>;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
  signal?: AbortSignal | undefined;
  forwardedAbortController?: AbortController | undefined;
  idle?: { warnMs?: number | undefined; killMs?: number | undefined } | undefined;
}

let sdkCallSequence = 0;

export function createSdkCallContext(opts: {
  role: RunnerCallContext['role'];
  model?: string | undefined;
}): RunnerCallContext {
  return {
    callId: `agent-sdk-${++sdkCallSequence}`,
    role: opts.role,
    backendKind: 'agent-sdk',
    runnerName: 'Agent SDK',
    ...(opts.model !== undefined && { model: opts.model }),
  };
}

function throwForSdkCallFailure(result: RunnerCallResult): never {
  const detail = result.error?.message;
  const message =
    detail && detail.length > 0
      ? `Agent SDK runner call ${result.status}: ${detail}`
      : `Agent SDK runner call ${result.status}`;
  throw error('runner-call-failed', message, {
    callId: result.callId,
    status: result.status,
    output: result.text,
    nativeSessionId: result.nativeSessionId,
    partial: result.partial,
    error: result.error,
  });
}

export async function processStream(opts: ProcessStreamOptions): Promise<StreamResult> {
  const { stream, onOutput, onSessionId, signal, forwardedAbortController } = opts;
  const context = opts.callContext ?? createSdkCallContext({ role: 'implementer' });
  let collectedText = '';
  let usage: Pick<TokenDelta, 'inputTokens' | 'outputTokens'> | null = null;
  let sessionId: string | null = null;
  let envelopeLimitFired = false;
  const onEvent = (event: RunnerCallEvent): void => {
    if (event.type === 'call_warning' && ENVELOPE_LIMIT_CODES.has(event.warning.code)) {
      envelopeLimitFired = true;
      forwardedAbortController?.abort(
        error('agent-sdk-envelope-limit', event.warning.message, { code: event.warning.code }),
      );
    }
    opts.onCallEvent?.(event);
  };
  const recorder = createRunnerCallRecorder({ context, onEvent });
  const textLimiter = createRunnerCallDeltaLimiter({
    code: 'agent_sdk_output_text_limit',
    label: 'Agent SDK output text',
  });
  let outputLimit: RunnerCallDeltaLimitResult['limit'] = null;

  function captureStreamSessionId(nextSessionId: string): void {
    if (sessionId === nextSessionId) return;
    sessionId = nextSessionId;
    onSessionId?.(nextSessionId);
    recorder.sessionId({ nativeSessionId: nextSessionId });
  }

  const watchdog = createIdleWatchdog({
    recorder,
    onKill: (idleError) => forwardedAbortController?.abort(idleError),
    warnMs: Math.min(
      opts.idle?.warnMs ?? RUNNER_IDLE_WARN_MS,
      context.envelope?.idleTimeoutMs ?? Infinity,
    ),
    killMs: Math.min(
      opts.idle?.killMs ?? RUNNER_IDLE_KILL_MS,
      context.envelope?.idleTimeoutMs ?? Infinity,
    ),
  });

  let iterator: AsyncIterator<unknown> | undefined;
  let iteratorDone = false;

  try {
    throwIfAborted(signal);
    iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const nextResult = iterator.next();
      nextResult.catch(() => {});
      const next = await Promise.race([nextResult, watchdog.killed]);
      watchdog.reset();
      if (next.done) {
        iteratorDone = true;
        break;
      }
      const rawMessage = next.value;
      throwIfAborted(signal);
      const decoded = decodeSdkMessage(rawMessage);
      if (!decoded.success) {
        recordInvalidSdkPayload(recorder, rawMessage, decoded.error.issues);
        continue;
      }
      const message = decoded.data;
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        captureStreamSessionId(message.session_id);
      }

      if (message.type === 'assistant') {
        const toolUses = extractToolUses(message, recorder);
        if (toolUses.length > 0) {
          for (const toolUse of toolUses) {
            recorder.toolUseDone({ toolUse });
          }
          collectedText = '';
        }
        const text = extractAssistantText(message, recorder);
        if (text) {
          const accepted = textLimiter.accept(text);
          if (accepted.text.length > 0) {
            collectedText += accepted.text;
            recorder.text({ channel: 'assistant', text: accepted.text });
            onOutput(accepted.text);
          }
          if (accepted.limit !== null) {
            outputLimit = accepted.limit;
            finishRunnerCallOutputLimit(recorder, outputLimit, {
              usage,
              nativeSessionId: sessionId,
            });
            break;
          }
          throwIfAborted(signal);
        }
      }

      if (message.type === 'result') {
        if (message.session_id) {
          captureStreamSessionId(message.session_id);
        }
        const delta = toTokenDelta(message.usage);
        if (delta) {
          usage = accumulateTokenUsage(usage, delta);
          recorder.usage({ usage: delta, semantics: 'final' });
        }
        if (isSdkResultFailure(message)) {
          recorder.finishFailed({
            status: sdkFailureStatus(message),
            error: {
              code: message.subtype ?? 'sdk_result_error',
              message: sdkResultErrorMessage(message),
            },
            usage,
            nativeSessionId: sessionId,
          });
          continue;
        }
        const resultText = extractResultText(message);
        if (context.envelope !== undefined && resultText.length === 0) {
          recorder.finishFailed({
            status: 'failed',
            error: {
              code: 'task_compiler_final_response_missing',
              message: 'Agent SDK result carried no final response text',
            },
            usage,
            nativeSessionId: sessionId,
          });
          continue;
        }
        if (resultText) {
          const reconciliation = reconcileFinalText(collectedText, resultText);
          const accepted =
            reconciliation.kind === 'none'
              ? ({ text: '', limit: null } satisfies RunnerCallDeltaLimitResult)
              : textLimiter.accept(reconciliation.text);
          if (reconciliation.kind === 'full') {
            if (accepted.text.length > 0) {
              recorder.text({ channel: 'result', text: accepted.text, semantics: 'final' });
              onOutput(accepted.text);
            }
          } else if (reconciliation.kind === 'suffix') {
            if (accepted.text.length > 0) {
              recorder.text({ channel: 'assistant', text: accepted.text });
              onOutput(accepted.text);
            }
          } else if (reconciliation.kind === 'replace') {
            if (accepted.text.length > 0) {
              recorder.text({ channel: 'result', text: accepted.text, semantics: 'final' });
            }
          }
          if (reconciliation.kind === 'full' || reconciliation.kind === 'replace') {
            collectedText = accepted.text;
          } else if (reconciliation.kind === 'suffix') {
            collectedText += accepted.text;
          }
          if (accepted.limit !== null) {
            outputLimit = accepted.limit;
            finishRunnerCallOutputLimit(recorder, outputLimit, {
              usage,
              nativeSessionId: sessionId,
            });
            break;
          }
        }
        recorder.finishCompleted({ usage, nativeSessionId: sessionId });
      }
      if (envelopeLimitFired) break;
    }
  } catch (err) {
    if (signal?.aborted) {
      recorder.finishFailed({
        status: runnerCallInterruptedStatus(signal),
        error: {
          code: 'runner_interrupted',
          message: signal.reason instanceof Error ? signal.reason.message : 'Agent SDK interrupted',
        },
        nativeSessionId: sessionId,
      });
    } else if (envelopeLimitFired) {
      recorder.finalResult();
    } else if (!recorder.hasTerminal()) {
      recorder.finishFailed({
        status: 'failed',
        error: processError.isIdleTimeout(err)
          ? runnerCallIdleTimeoutError(err)
          : runnerCallErrorFromUnknown(err, 'agent_sdk_stream_error'),
        usage,
        nativeSessionId: sessionId,
      });
    }
    recorder.finalResult();
    throw err;
  } finally {
    if (iterator && !iteratorDone) iterator.return?.().catch(() => {});
    watchdog.stop();
  }

  const result = recorder.finalResult();
  if (result.status !== 'completed') throwForSdkCallFailure(result);

  return { ...result, text: collectedText, sessionId };
}
