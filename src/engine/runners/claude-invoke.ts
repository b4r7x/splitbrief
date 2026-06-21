import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { spawnWithStdin } from '../../lib/process/spawn.js';
import { processError } from '../../lib/process/errors.js';
import { parseStreamLine } from '../streaming/parse-stream-json.js';
import { reconcileFinalText } from '../streaming/final-text.js';
import { createQuestionAccumulator } from '../parsers/question.js';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../calls/recorder.js';
import { runnerCallErrorFromUnknown, runnerCallInterruptedStatus } from '../calls/status.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { isRecord } from '../../utils/type-guards.js';

const CLAUDE_NOT_FOUND = 'Claude Code CLI not found. Install it from https://claude.ai/code';

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

let claudeCallSequence = 0;

interface ContentBlockTool {
  id: string | null;
  name: string;
}

function createClaudeCallContext(opts: {
  role: RunnerCallContext['role'];
  model?: string | undefined;
}): RunnerCallContext {
  return {
    callId: `claude-${++claudeCallSequence}`,
    role: opts.role,
    backendKind: 'cli',
    runnerName: 'claude',
    ...(opts.model !== undefined && { model: opts.model }),
  };
}

function createStreamHandler(callbacks: StreamHandlerCallbacks) {
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

  function emitAssistantOutput(text: string): void {
    callbacks.onOutput(text);

    if (callbacks.onQuestion && questionAccumulator) {
      const newQuestions = questionAccumulator.addChunk(text);
      if (newQuestions.length > 0) {
        callbacks.onQuestion(newQuestions);
      }
    }
  }

  function handleLine(line: string): void {
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
      state.recorder.text({ channel, text: parsed.text });
      if (channel === 'assistant' || channel === 'stdout') {
        state.text += parsed.text;
        emitAssistantOutput(parsed.text);
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
        state.resultText = parsed.text;
        const reconciliation = reconcileFinalText(state.text, parsed.text);
        if (reconciliation.kind === 'full') {
          state.recorder.text({ channel: 'result', text: parsed.text, semantics: 'final' });
          emitAssistantOutput(parsed.text);
        } else if (reconciliation.kind === 'suffix') {
          state.recorder.text({ channel: 'assistant', text: reconciliation.text });
          emitAssistantOutput(reconciliation.text);
        } else if (reconciliation.kind === 'replace') {
          state.recorder.text({ channel: 'result', text: parsed.text, semantics: 'final' });
        }
        state.text = parsed.text;
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

function finishClaudeStream(state: StreamHandlerState): RunnerCallResult {
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

function markInterruptedClaudeStream(
  state: StreamHandlerState,
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

function markFailedClaudeStream(state: StreamHandlerState, err: unknown): void {
  if (state.recorder.hasTerminal()) return;
  state.recorder.finishFailed({
    status: 'failed',
    error: runnerCallErrorFromUnknown(err, 'claude_process_error'),
    usage: state.usage,
    nativeSessionId: state.sessionId,
  });
  state.recorder.finalResult();
}

function interruptedError(signal: AbortSignal | undefined, fallback: unknown): unknown {
  if (!signal?.aborted) return fallback;
  return signal.reason instanceof Error ? signal.reason : fallback;
}

interface BuildArgsOpts {
  sessionId?: string | null;
  model?: string | undefined;
  effort?: EffortLevel | undefined;
  permissionMode?: 'acceptEdits' | undefined;
}

function applyImageRefs(prompt: string, images: Attachment[] | undefined): string {
  if (!images || images.length === 0) return prompt;
  const refs = images.map((img) => `[image attachment: ${img.path}]`).join('\n');
  return `${refs}\n\n${prompt}`;
}

function buildClaudeArgs(opts: BuildArgsOpts): string[] {
  const { sessionId, model, effort, permissionMode } = opts;
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];

  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (sessionId) args.push('--session-id', sessionId);
  return args;
}

type ClaudePlannerStreamResult = RunnerCallResult & { sessionId?: string | null };

export interface ClaudePlannerStreamOpts {
  prompt: string;
  projectDir: string;
  sessionId: string | null;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  model?: string | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
}

export async function runClaudePlannerStream(
  opts: ClaudePlannerStreamOpts,
): Promise<ClaudePlannerStreamResult> {
  const {
    prompt,
    projectDir,
    sessionId,
    onOutput,
    onSessionId,
    onQuestion,
    onCallEvent,
    model,
    effort,
    images,
    signal,
    callContext,
  } = opts;
  const args = buildClaudeArgs({ sessionId, model, effort });

  const context = callContext ?? createClaudeCallContext({ role: 'planner', model });
  const { state, handleLine } = createStreamHandler({
    onOutput,
    onSessionId,
    onQuestion,
    onCallEvent,
    context,
  });
  state.sessionId = sessionId;

  try {
    await spawnWithStdin({
      command: 'claude',
      args,
      cwd: projectDir,
      stdin: applyImageRefs(prompt, images),
      notFoundMessage: CLAUDE_NOT_FOUND,
      onLine: handleLine,
      errorDetail: () => state.resultText ?? undefined,
      signal,
    });
  } catch (err) {
    markInterruptedClaudeStream(state, signal);
    if (!signal?.aborted) markFailedClaudeStream(state, err);
    throw interruptedError(signal, err);
  }

  const result = finishClaudeStream(state);

  return { ...result, text: state.text, sessionId: state.sessionId };
}

export interface ClaudeOneShotOpts {
  prompt: string;
  projectDir: string;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  model?: string | undefined;
  effort?: EffortLevel | undefined;
  permissionMode?: 'acceptEdits' | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export async function runClaudeOneShot(opts: ClaudeOneShotOpts): Promise<RunnerCallResult> {
  const {
    prompt,
    projectDir,
    onOutput,
    onSessionId,
    onCallEvent,
    model,
    effort,
    permissionMode,
    signal,
    callContext,
    env,
  } = opts;
  const context =
    callContext ??
    createClaudeCallContext({
      role: permissionMode === 'acceptEdits' ? 'implementer' : 'planner',
      model,
    });
  const { state, handleLine } = createStreamHandler({
    onOutput,
    onSessionId,
    onCallEvent,
    context,
  });
  const args = buildClaudeArgs({ model, effort, permissionMode });

  try {
    await spawnWithStdin({
      command: 'claude',
      args,
      cwd: projectDir,
      env,
      stdin: prompt,
      notFoundMessage: CLAUDE_NOT_FOUND,
      onLine: handleLine,
      errorDetail: () => state.resultText ?? undefined,
      signal,
    });
  } catch (err) {
    markInterruptedClaudeStream(state, signal);
    if (!signal?.aborted) markFailedClaudeStream(state, err);
    throw interruptedError(signal, err);
  }

  const result = finishClaudeStream(state);

  return { ...result, text: state.text };
}
