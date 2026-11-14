import type { RunnerCallRecorder } from '../../calls/recorder/types.js';
import type { RunnerCallCredentialRedactor } from '../../calls/status.js';
import type { RunnerCallUsage } from '../../calls/types.js';
import type { OpenAICompatPolicy, OpenAICompatFinishReason } from '../openai-compat-policy.js';
import type { StreamChoiceDelta } from './chunk.js';

export function emitText(
  recorder: RunnerCallRecorder,
  text: string,
  onProgress: (text: string) => void,
  redactCredential: RunnerCallCredentialRedactor,
): void {
  if (text.length === 0) return;
  const safeText = redactCredential(text);
  recorder.text({ channel: 'assistant', text: safeText });
  onProgress(safeText);
}

export function emitToolUseDeltas(
  recorder: RunnerCallRecorder,
  delta: StreamChoiceDelta | undefined,
  redactCredential: RunnerCallCredentialRedactor,
): void {
  if (delta === undefined) return;

  for (const toolCall of delta.tool_calls ?? []) {
    recorder.toolUseDelta({
      toolUseId: toolCall.id === undefined ? null : redactCredential(toolCall.id),
      name: toolCall.function?.name === undefined ? null : redactCredential(toolCall.function.name),
      inputDelta: redactCredential(toolCall.function?.arguments ?? ''),
    });
  }

  if (delta.function_call !== undefined) {
    recorder.toolUseDelta({
      toolUseId: null,
      name:
        delta.function_call.name === undefined ? null : redactCredential(delta.function_call.name),
      inputDelta: redactCredential(delta.function_call.arguments ?? ''),
    });
  }
}

export function emitOpenAiTerminal(
  recorder: RunnerCallRecorder,
  finishReason: string | null,
  usage: RunnerCallUsage | null,
  policy: OpenAICompatPolicy,
): void {
  if (finishReason !== null && !isPolicyFinishReason(policy, finishReason)) {
    recorder.finishFailed({
      status: 'failed',
      error: {
        code: 'openai_unknown_finish_reason',
        message: `OpenAI response ended with unknown finish_reason ${finishReason}`,
      },
      usage,
      nativeSessionId: null,
    });
    return;
  }

  switch (finishReason) {
    case 'stop':
      recorder.finishCompleted({ usage, nativeSessionId: null });
      return;
    case 'length':
      recorder.finishFailed({
        status: 'truncated',
        error: {
          code: 'output-token-limit',
          message: 'OpenAI response ended because the max token limit was reached',
        },
        usage,
        nativeSessionId: null,
      });
      return;
    case 'content_filter':
      recorder.finishFailed({
        status: 'refused',
        error: {
          code: 'openai_finish_reason_content_filter',
          message: 'OpenAI response was blocked by the content filter',
        },
        usage,
        nativeSessionId: null,
      });
      return;
    case 'tool_calls':
    case 'function_call':
      recorder.finishFailed({
        status: 'unsupported_tool',
        error: {
          code: `openai_finish_reason_${finishReason}`,
          message: `OpenAI response requested unsupported ${finishReason}`,
        },
        usage,
        nativeSessionId: null,
      });
      return;
    case null:
      return;
    default: {
      const exhaustive: never = finishReason;
      recorder.finishFailed({
        status: 'failed',
        error: {
          code: 'openai_unknown_finish_reason',
          message: `OpenAI response ended with unknown finish_reason ${exhaustive}`,
        },
        usage,
        nativeSessionId: null,
      });
    }
  }
}

export function isPolicyFinishReason(
  policy: OpenAICompatPolicy,
  finishReason: string,
): finishReason is OpenAICompatFinishReason {
  return policy.finishReasons.some((allowedReason) => allowedReason === finishReason);
}
