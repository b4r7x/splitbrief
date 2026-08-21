import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { parseStreamLine } from '../../streaming/parse-stream-json.js';
import { reconcileFinalText } from '../../streaming/final-text.js';
import { createQuestionAccumulator } from '../../parsers/question.js';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../../calls/recorder.js';
import {
  createRunnerCallCredentialRedactor,
  runnerCallErrorFromUnknown,
  runnerCallIdleTimeoutError,
  runnerCallInterruptedStatus,
} from '../../calls/status.js';
import type { RunnerCallCredentialRedactor } from '../../calls/status.js';
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
import { error } from '../../../utils/error.js';
import { isRecord } from '../../../utils/type-guards.js';
import { redactSecrets } from '../../../utils/redact.js';

interface StreamHandlerState {
  text: string;
  sessionId: string | null;
  usage: TokenDelta | null;
  resultText: string | null;
  sawResult: boolean;
  sawResultText: boolean;
  isError: boolean;
  recorder: RunnerCallRecorder;
  credentialValues: readonly string[];
  redactCredential: RunnerCallCredentialRedactor;
  activeToolUse: ContentBlockTool | null;
  contentBlockTools: Map<number, ContentBlockTool>;
}

interface StreamHandlerCallbacks {
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  credentialValues?: readonly string[] | undefined;
  context: RunnerCallContext;
}

interface ContentBlockTool {
  id: string | null;
  name: string;
}

export function createStreamHandler(callbacks: StreamHandlerCallbacks) {
  const recorder = createRunnerCallRecorder({
    context: callbacks.context,
    credentialValues: callbacks.credentialValues,
    onEvent: callbacks.onCallEvent,
  });
  const credentialValues = callbacks.credentialValues ?? [];
  const explicitRedactor = createRunnerCallCredentialRedactor(credentialValues);
  const redactCredential = (value: string): string => redactSecrets(explicitRedactor(value));
  const state: StreamHandlerState = {
    text: '',
    sessionId: null,
    usage: null,
    resultText: null,
    sawResult: false,
    sawResultText: false,
    isError: false,
    recorder,
    credentialValues,
    redactCredential,
    activeToolUse: null,
    contentBlockTools: new Map(),
  };
  const questionAccumulator = callbacks.onQuestion ? createQuestionAccumulator() : null;
  /** Assistant text streamed since the last completed content block. */
  let blockText = '';
  const textLimiter = createRunnerCallDeltaLimiter({
    code: 'runner_output_text_limit',
    label: 'runner output text',
  });

  function emitAssistantOutput(text: string): void {
    const safeText = redactCredential(text);
    callbacks.onOutput(safeText);

    if (callbacks.onQuestion && questionAccumulator) {
      const newQuestions = questionAccumulator.addChunk(safeText);
      if (newQuestions.length > 0) {
        callbacks.onQuestion(newQuestions);
      }
    }
  }

  function acceptTextDelta(text: string): RunnerCallDeltaLimitResult {
    const accepted = textLimiter.accept(text);
    return { ...accepted, text: redactCredential(accepted.text) };
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
        blockText += accepted.text;
        emitAssistantOutput(accepted.text);
      }
    }
    return finishLimitIfNeeded(accepted);
  }

  /**
   * A non-partial `assistant` record restates the block whose `text_delta`
   * slices already streamed, so only the part the deltas did not carry is new.
   * A `replace` means the restatement diverges from those deltas rather than
   * extending them; emitting it here would re-print text the deltas already
   * streamed, so it is dropped deliberately and `applyResultText` reconciles the
   * divergence once against the terminal `result` record.
   */
  function applyAssistantMessage(text: string): boolean {
    const reconciliation = reconcileFinalText(blockText, redactCredential(text));
    const missing =
      reconciliation.kind === 'full' || reconciliation.kind === 'suffix' ? reconciliation.text : '';
    const limited = missing.length > 0 ? applyStreamText('assistant', missing) : false;
    blockText = '';
    return limited;
  }

  function applyResultText(text: string): boolean {
    const safeText = redactCredential(text);
    state.resultText = safeText;
    // Only a terminal `result` record carrying text can complete the call.
    state.sawResultText = true;
    const reconciliation = reconcileFinalText(state.text, safeText);
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
      const sessionId = redactCredential(parsed.sessionId);
      // Every stream-json frame restates the id, and the callback persists
      // workflow state on each call, so only a change is news.
      if (sessionId !== state.sessionId) {
        state.sessionId = sessionId;
        callbacks.onSessionId?.(sessionId);
        state.recorder.sessionId({ nativeSessionId: sessionId });
      }
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
      // `final` text restates a block the partial-message deltas already
      // streamed, so it replaces the accumulated text instead of extending it.
      if (parsed.textSemantics === 'final') {
        if (applyAssistantMessage(parsed.text)) return;
      } else {
        const channel = parsed.channel ?? 'assistant';
        if (applyStreamText(channel, parsed.text)) return;
      }
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

export function throwForClaudeCallFailure(result: RunnerCallResult): never {
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
    if (!state.sawResultText && state.recorder.context.envelope !== undefined) {
      // A `result` record without text is a missing final response: it cannot
      // complete the call or fall back to earlier partials (REQ-013).
      state.recorder.finishFailed({
        status: 'failed',
        error: {
          code: 'task_compiler_final_response_missing',
          message: 'Claude result carried no final response text',
        },
        usage: state.usage,
        nativeSessionId: state.sessionId,
        partial: true,
      });
    } else {
      state.recorder.finishCompleted({
        usage: state.usage,
        nativeSessionId: state.sessionId,
      });
    }
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
      message:
        signal.reason instanceof Error
          ? state.redactCredential(signal.reason.message)
          : 'Claude stream interrupted',
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
      ? runnerCallIdleTimeoutError(err, state.credentialValues)
      : runnerCallErrorFromUnknown(err, 'claude_process_error', state.credentialValues),
    usage: state.usage,
    nativeSessionId: state.sessionId,
  });
  state.recorder.finalResult();
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
