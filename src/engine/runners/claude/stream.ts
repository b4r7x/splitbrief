import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { parseStreamLine } from '../../streaming/parse-stream-json.js';
import { reconcileFinalText } from '../../streaming/final-text.js';
import { createQuestionAccumulator } from '../../parsers/question.js';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../../calls/recorder.js';
import {
  runnerCallErrorFromUnknown,
  runnerCallIdleTimeoutError,
  runnerCallInterruptedStatus,
} from '../../calls/status.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../../calls/types.js';
import {
  createRunnerCallDeltaLimiter,
  finishRunnerCallOutputLimit,
  type RunnerCallDeltaLimitResult,
  type RunnerCallOutputLimit,
} from '../../calls/output-limit.js';
import { processError } from '../../../lib/process/errors.js';
import type { SpawnIdleOptions } from '../../../lib/process/spawn/lifecycle.js';
import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../../core/schemas/runner-fields.js';
import { isRecord } from '../../../utils/type-guards.js';

interface StreamHandlerState {
  text: string;
  sessionId: string | null;
  usage: TokenDelta | null;
  resultText: string | null;
  sawResult: boolean;
  isError: boolean;
  recorder: RunnerCallRecorder;
  activeToolUse: ContentBlockTool | null;
  contentBlockTools: Map<number, ContentBlockTool>;
}

interface StreamHandlerCallbacks {
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  context: RunnerCallContext;
}

interface ContentBlockTool {
  id: string | null;
  name: string;
}

export function createStreamHandler(callbacks: StreamHandlerCallbacks) {
  const recorder = createRunnerCallRecorder({
    context: callbacks.context,
    onEvent: callbacks.onCallEvent,
  });
  const state: StreamHandlerState = {
    text: '',
    sessionId: null,
    usage: null,
    resultText: null,
    sawResult: false,
    isError: false,
    recorder,
    activeToolUse: null,
    contentBlockTools: new Map(),
  };
  const questionAccumulator = callbacks.onQuestion ? createQuestionAccumulator() : null;
  const textLimiter = createRunnerCallDeltaLimiter({
    code: 'runner_output_text_limit',
    label: 'runner output text',
  });

  function emitAssistantOutput(text: string): void {
    callbacks.onOutput(text);

    if (callbacks.onQuestion && questionAccumulator) {
      const newQuestions = questionAccumulator.addChunk(text);
      if (newQuestions.length > 0) {
        callbacks.onQuestion(newQuestions);
      }
    }
  }

  function acceptTextDelta(text: string): RunnerCallDeltaLimitResult {
    return textLimiter.accept(text);
  }

  function finishLimitIfNeeded(result: RunnerCallDeltaLimitResult): boolean {
    if (result.limit === null) return false;
    finishClaudeOutputLimit(state, result.limit);
    return true;
  }

  function applyStreamText(
    channel: NonNullable<ReturnType<typeof parseStreamLine>['channel']>,
    text: string,
  ): boolean {
    const accepted = acceptTextDelta(text);
    if (accepted.text.length > 0) {
      state.recorder.text({ channel, text: accepted.text });
      if (channel === 'assistant' || channel === 'stdout') {
        state.text += accepted.text;
        emitAssistantOutput(accepted.text);
      }
    }
    return finishLimitIfNeeded(accepted);
  }

  function applyResultText(text: string): boolean {
    state.resultText = text;
    const reconciliation = reconcileFinalText(state.text, text);
    if (reconciliation.kind === 'none') return false;

    const accepted = acceptTextDelta(reconciliation.text);
    if (reconciliation.kind === 'full') {
      if (accepted.text.length > 0) {
        state.recorder.text({ channel: 'result', text: accepted.text, semantics: 'final' });
        emitAssistantOutput(accepted.text);
      }
      state.text = accepted.text;
    } else if (reconciliation.kind === 'suffix') {
      if (accepted.text.length > 0) {
        state.recorder.text({ channel: 'assistant', text: accepted.text });
        emitAssistantOutput(accepted.text);
      }
      state.text += accepted.text;
    } else if (reconciliation.kind === 'replace') {
      if (accepted.text.length > 0) {
        state.recorder.text({ channel: 'result', text: accepted.text, semantics: 'final' });
      }
      state.text = accepted.text;
    }
    return finishLimitIfNeeded(accepted);
  }

  function handleLine(line: string): void {
    if (state.recorder.hasTerminal()) return;

    const contentBlockToolStart = parseContentBlockToolStart(line);
    if (contentBlockToolStart) {
      state.contentBlockTools.set(contentBlockToolStart.index, contentBlockToolStart.toolUse);
    }

    const parsed = parseStreamLine(line);

    if (parsed.sessionId) {
      state.sessionId = parsed.sessionId;
      callbacks.onSessionId?.(parsed.sessionId);
      state.recorder.sessionId({ nativeSessionId: parsed.sessionId });
    }

    if (parsed.toolUse) {
      for (const toolUse of parsed.toolUse) {
        state.recorder.toolUseDone({
          toolUse: {
            id: toolUse.id ?? null,
            name: toolUse.name,
            input: toolUse.input,
            ...(toolUse.output !== undefined && { output: toolUse.output }),
          },
        });
      }
    }

    if (parsed.toolUseStart) {
      for (const toolUse of parsed.toolUseStart) {
        state.activeToolUse = {
          id: toolUse.id ?? null,
          name: toolUse.name,
        };
        state.recorder.toolUseDelta({
          toolUseId: toolUse.id ?? null,
          name: toolUse.name,
          inputDelta: JSON.stringify(toolUse.input),
        });
      }
    }

    if (parsed.toolUseDelta) {
      for (const toolUse of parsed.toolUseDelta) {
        const resolvedToolUse = resolveToolUseDelta(state, toolUse);
        state.recorder.toolUseDelta({
          toolUseId: resolvedToolUse.id,
          name: resolvedToolUse.name,
          inputDelta: toolUse.inputDelta,
        });
      }
    }

    if (parsed.text && !parsed.isResult) {
      const channel = parsed.channel ?? 'assistant';
      if (applyStreamText(channel, parsed.text)) return;
    }

    if (parsed.warning) {
      for (const warning of parsed.warning) {
        state.recorder.warning({ warning });
      }
    }

    if (parsed.isResult) {
      state.sawResult = true;
      if (parsed.text) {
        if (applyResultText(parsed.text)) return;
      }
    }

    if (parsed.usage) {
      state.usage = parsed.usage;
      state.recorder.usage({
        usage: parsed.usage,
        semantics: parsed.isResult ? 'final' : 'delta',
      });
    }

    if (parsed.isError) {
      state.isError = true;
      state.recorder.finishFailed({
        status: 'failed',
        error: {
          code: 'runner_result_error',
          message: (state.resultText ?? state.text) || 'Claude result failed',
        },
        nativeSessionId: state.sessionId,
      });
    }
  }

  return { state, handleLine };
}

export type ClaudeStreamState = ReturnType<typeof createStreamHandler>['state'];

export function buildClaudeIdleOptions(
  state: ClaudeStreamState,
  opts: { idleWarnMs?: number | undefined; idleKillMs?: number | undefined },
): SpawnIdleOptions {
  return {
    warnMs: opts.idleWarnMs ?? RUNNER_IDLE_WARN_MS,
    killMs: opts.idleKillMs ?? RUNNER_IDLE_KILL_MS,
    onWarn: (silentMs) => state.recorder.stalled({ silentMs }),
    onClear: () => state.recorder.stallCleared(),
  };
}

export function finishClaudeOutputLimit(
  state: ClaudeStreamState,
  limit: RunnerCallOutputLimit,
): void {
  finishRunnerCallOutputLimit(state.recorder, limit, {
    usage: state.usage,
    nativeSessionId: state.sessionId,
  });
}

function parseContentBlockToolStart(
  line: string,
): { index: number; toolUse: ContentBlockTool } | null {
  if (!line.trim()) return null;
  try {
    const event: unknown = JSON.parse(line);
    if (!isRecord(event) || !isRecord(event.event)) return null;
    const streamEvent = event.event;
    if (streamEvent.type !== 'content_block_start') return null;
    if (typeof streamEvent.index !== 'number') return null;
    if (!Number.isSafeInteger(streamEvent.index)) return null;
    if (!isRecord(streamEvent.content_block)) return null;
    const block = streamEvent.content_block;
    if (block.type !== 'tool_use' || typeof block.name !== 'string') return null;
    return {
      index: streamEvent.index,
      toolUse: {
        id: typeof block.id === 'string' ? block.id : null,
        name: block.name,
      },
    };
  } catch {
    return null;
  }
}

function contentBlockIndex(id: string | undefined): number | null {
  const match = id?.match(/^content-block-(\d+)$/);
  if (!match) return null;
  const rawIndex = match[1];
  if (rawIndex === undefined) return null;
  const index = Number(rawIndex);
  return Number.isSafeInteger(index) ? index : null;
}

function resolveToolUseDelta(
  state: StreamHandlerState,
  toolUse: { id?: string | undefined; name?: string | undefined },
): { id: string | null; name: string | null } {
  const index = contentBlockIndex(toolUse.id);
  const indexedToolUse = index === null ? undefined : state.contentBlockTools.get(index);
  const fallback =
    indexedToolUse ??
    (index !== null || toolUse.id === state.activeToolUse?.id ? state.activeToolUse : null);
  return {
    id: fallback?.id ?? toolUse.id ?? null,
    name: toolUse.name ?? fallback?.name ?? null,
  };
}

function throwForClaudeCallFailure(result: RunnerCallResult): never {
  throw processError.exitCode({
    command: 'claude',
    code: 0,
    stderr: '',
    output: result.text,
    detail: result.error?.message ?? `Claude runner call ended with ${result.status}`,
  });
}

export function finishClaudeStream(state: ClaudeStreamState): RunnerCallResult {
  if (!state.isError && state.sawResult) {
    state.recorder.finishCompleted({
      usage: state.usage,
      nativeSessionId: state.sessionId,
    });
  }

  const result = state.recorder.finalResult();
  if (result.status !== 'completed') throwForClaudeCallFailure(result);
  return result;
}

export function markInterruptedClaudeStream(
  state: ClaudeStreamState,
  signal: AbortSignal | undefined,
): void {
  if (!signal?.aborted) return;
  state.recorder.finishFailed({
    status: runnerCallInterruptedStatus(signal),
    error: {
      code: 'runner_interrupted',
      message: signal.reason instanceof Error ? signal.reason.message : 'Claude stream interrupted',
    },
    nativeSessionId: state.sessionId,
  });
  state.recorder.finalResult();
}

export function markFailedClaudeStream(state: ClaudeStreamState, err: unknown): void {
  if (state.recorder.hasTerminal()) return;
  state.recorder.finishFailed({
    status: 'failed',
    // Idle kills report through the shared runner_idle_timeout contract
    // (calls/status.ts), matching every other backend; runnerCallErrorFromUnknown
    // would leak the raw 'command-idle-timeout' kind as the event code.
    error: processError.isIdleTimeout(err)
      ? runnerCallIdleTimeoutError(err)
      : runnerCallErrorFromUnknown(err, 'claude_process_error'),
    usage: state.usage,
    nativeSessionId: state.sessionId,
  });
  state.recorder.finalResult();
}

export function interruptedError(signal: AbortSignal | undefined, fallback: unknown): unknown {
  if (!signal?.aborted) return fallback;
  return signal.reason instanceof Error ? signal.reason : fallback;
}
