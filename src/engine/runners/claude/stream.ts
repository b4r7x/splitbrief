import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { createStreamParser } from '../../streaming/parse-stream-json.js';
import { appendMessage, reconcileFinalText } from '../../streaming/final-text.js';
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
import { createRunnerCallDeltaLimiter } from '../../calls/output-limit.js';
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
  structured?: unknown;
  recorder: RunnerCallRecorder;
  credentialValues: readonly string[];
  redactCredential: RunnerCallCredentialRedactor;
  activeToolUse: ContentBlockTool | null;
  contentBlockTools: Map<number, ContentBlockTool>;
}

interface StreamHandlerCallbacks {
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onSessionInit?: ((id: string) => void) | undefined;
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
  const parseStreamLine = createStreamParser();
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
  /** Main-loop text streamed since the last completed content block. */
  let blockText = '';
  /** Main-loop text of the open message; the terminal `result` restates it. */
  let messageText = '';
  /**
   * Main-loop text of the messages the open one continues: the message a
   * `max_tokens` stop cut, and every message after it. Empty outside that chain.
   */
  let carriedText = '';
  /** The open message resumes a `max_tokens` cut mid-thought and extends `carriedText` in place. */
  let resumesCut = false;
  /** The open message belongs to a chain a `max_tokens` stop opened. */
  let inChain = false;
  /** The last closed main-loop message that had text, behind its chain. */
  let lastClosedText = '';
  let messageStopReason: string | undefined;
  /** Bounds only what streams live; the recorder bounds the call's text. */
  const liveLimiter = createRunnerCallDeltaLimiter({
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

  function applyStreamText(
    channel: NonNullable<ReturnType<typeof parseStreamLine>['channel']>,
    text: string,
    partial = false,
  ): void {
    const safeText = redactCredential(text);
    const isReply = channel === 'assistant' || channel === 'stdout';
    if (isReply) {
      // Kept whole, past the output budget, so a restatement is compared with
      // what really streamed and the call's text keeps every carried message.
      blockText += safeText;
      messageText += safeText;
    }
    // The recorder cuts the text past its budget and reports the cut only when
    // the text the call ends with was cut, not narration a final text replaced.
    state.recorder.text({
      channel,
      text: safeText,
      ...(partial && { semantics: 'delta' as const }),
    });
    const live = liveLimiter.accept(safeText).text;
    if (isReply && live.length > 0) {
      state.text += live;
      emitAssistantOutput(live);
    }
  }

  /**
   * A non-partial `assistant` record restates the block whose `text_delta`
   * slices already streamed, so only the part the deltas did not carry is new.
   * A `replace` means the restatement diverges from those deltas rather than
   * extending them; emitting it here would re-print text the deltas already
   * streamed, so it is dropped deliberately and `applyResultText` reconciles the
   * divergence once against the terminal `result` record.
   */
  function applyAssistantMessage(text: string): void {
    const reconciliation = reconcileFinalText(blockText, redactCredential(text));
    const missing =
      reconciliation.kind === 'full' || reconciliation.kind === 'suffix' ? reconciliation.text : '';
    if (missing.length > 0) {
      applyStreamText('assistant', missing);
    }
    blockText = '';
  }

  /** The open chain ending on `message`, the open message's text or its restatement. */
  function chainText(message: string): string {
    return resumesCut ? carriedText + message : appendMessage(carriedText, message);
  }

  /**
   * The call's text is the final message behind its chain; narration that ended
   * on a tool call outside a chain streamed live and stays out of it.
   */
  function settleFinalText(finalText: string): void {
    if (finalText !== state.text) {
      state.recorder.text({ channel: 'result', text: finalText, semantics: 'final' });
    }
  }

  /** `result.result` restates the final message only. */
  function applyResultText(text: string): void {
    const safeText = redactCredential(text);
    state.resultText = safeText;
    // Only a terminal `result` record carrying text can complete the call.
    state.sawResultText = true;
    const reconciliation = reconcileFinalText(messageText, safeText);
    if (reconciliation.kind === 'full' || reconciliation.kind === 'suffix') {
      applyStreamText('assistant', reconciliation.text);
    }
    settleFinalText(chainText(safeText));
  }

  /**
   * claude-code answers a `max_tokens` stop with "Output token limit hit. Resume
   * directly" and a new message that has every tool, so a cut document can go on
   * after a tool call: the chain stays open through tool calls and closes on any
   * other stop.
   */
  function applyMessageBoundary(parsed: ReturnType<typeof parseStreamLine>): void {
    if (parsed.isMessageStart) {
      const closed = chainText(messageText);
      if (closed.length > 0) lastClosedText = closed;
      const cut = messageStopReason === 'max_tokens';
      const continues = cut || (inChain && messageStopReason === 'tool_use');
      carriedText = continues ? closed : '';
      resumesCut = cut;
      inChain = continues;
      messageText = '';
      messageStopReason = undefined;
    }
    if (parsed.stopReason !== undefined) messageStopReason = parsed.stopReason;
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
      if (parsed.isSessionInit) callbacks.onSessionInit?.(sessionId);
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
          stage: 'started',
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

    if (!parsed.isSubagent) applyMessageBoundary(parsed);

    if (parsed.text && !parsed.isResult) {
      if (parsed.isSubagent) {
        // A subagent's whole record shows live; it is not the planner's reply.
        if (parsed.textSemantics === 'final') callbacks.onOutput(redactCredential(parsed.text));
      } else if (parsed.textSemantics === 'final') {
        // `final` text restates a block the partial-message deltas already
        // streamed, so it replaces the accumulated text instead of extending it.
        applyAssistantMessage(parsed.text);
      } else {
        const channel = parsed.channel ?? 'assistant';
        // A partial-message delta carries ~10 characters; the event budget
        // counts records, and the byte budget bounds the text either way.
        applyStreamText(channel, parsed.text, parsed.textSemantics === 'delta');
      }
    }

    if (parsed.warning) {
      for (const warning of parsed.warning) {
        state.recorder.warning({ warning });
      }
    }

    if (parsed.isHeartbeat) state.recorder.heartbeat();

    if (parsed.isResult) {
      state.sawResult = true;
      if (parsed.structured !== undefined) state.structured = parsed.structured;
      if (parsed.text) {
        applyResultText(parsed.text);
      } else if (!parsed.isError) {
        // A result without text still ends the open message: it and its chain
        // are the call's text, or the last message that had text when it had
        // none, never the whole stream.
        const open = chainText(messageText);
        settleFinalText(open.length > 0 ? open : lastClosedText);
      }
    }

    if (parsed.usage) {
      state.usage = parsed.usage;
      state.recorder.usage({
        usage: parsed.usage,
        semantics: parsed.usageSemantics ?? 'cumulative',
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
  const detail = result.error?.message;
  const message =
    detail !== undefined && detail.length > 0
      ? `Claude runner call ${result.status}: ${detail}`
      : `Claude runner call ${result.status}`;
  throw error('runner-call-failed', message, {
    callId: result.callId,
    status: result.status,
    output: result.text,
    nativeSessionId: result.nativeSessionId,
    partial: result.partial,
    error: result.error,
  });
}

export function finishClaudeStream(state: ClaudeStreamState): RunnerCallResult {
  if (!state.isError && state.sawResult) {
    state.recorder.finishCompleted({
      usage: state.usage,
      nativeSessionId: state.sessionId,
      ...(state.structured !== undefined && { structured: state.structured }),
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
