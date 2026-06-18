import type { InvokeResult } from './types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { spawnWithStdin } from '../../lib/process/spawn.js';
import { processError } from '../../lib/process/errors.js';
import { parseStreamLine } from '../streaming/parse-stream-json.js';
import type { ToolUseInfo } from './types.js';
import { createQuestionAccumulator } from '../parsers/question.js';
import { collectRunnerCallResult } from '../calls/collector.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';

const CLAUDE_NOT_FOUND = 'Claude Code CLI not found. Install it from https://claude.ai/code';

interface ToolFormat {
  field: string;
  quoted?: boolean;
  maxLen?: number;
}

const TOOL_FORMATS: Record<string, ToolFormat> = {
  Read: { field: 'file_path' },
  Write: { field: 'file_path' },
  Edit: { field: 'file_path' },
  Glob: { field: 'pattern' },
  Skill: { field: 'skill' },
  NotebookEdit: { field: 'file_path' },
  Grep: { field: 'pattern', quoted: true },
  WebSearch: { field: 'query', quoted: true },
  ToolSearch: { field: 'query', quoted: true },
  Bash: { field: 'command', maxLen: 60 },
  WebFetch: { field: 'url', maxLen: 80 },
};

function formatToolUse(tool: ToolUseInfo): string {
  if (tool.name === 'Agent') {
    const prefix = tool.input.subagent_type ? `${tool.input.subagent_type}: ` : '';
    return `→ Agent ${prefix}${String(tool.input.description ?? '').slice(0, 60)}`;
  }

  const fmt = TOOL_FORMATS[tool.name];
  if (fmt) {
    let value = String(tool.input[fmt.field] ?? '');
    if (fmt.maxLen) value = value.slice(0, fmt.maxLen);
    return fmt.quoted ? `→ ${tool.name} "${value}"` : `→ ${tool.name} ${value}`;
  }

  const hint = Object.values(tool.input).find((v) => typeof v === 'string');
  return `→ ${tool.name}${hint ? ' ' + String(hint).slice(0, 60) : ''}`;
}

interface StreamHandlerState {
  text: string;
  sessionId: string | null;
  usage: TokenDelta | null;
  resultText: string | null;
  sawResult: boolean;
  isError: boolean;
  sawAssistantText: boolean;
  events: RunnerCallEvent[];
}

interface StreamHandlerCallbacks {
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  context: RunnerCallContext;
}

let claudeCallSequence = 0;

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
  const state: StreamHandlerState = {
    text: '',
    sessionId: null,
    usage: null,
    resultText: null,
    sawResult: false,
    isError: false,
    sawAssistantText: false,
    events: [],
  };
  const questionAccumulator = callbacks.onQuestion ? createQuestionAccumulator() : null;
  const emit = (event: RunnerCallEvent): void => {
    state.events.push(event);
    callbacks.onCallEvent?.(event);
  };

  emit({ type: 'call_started', ts: Date.now(), ...callbacks.context });

  function handleLine(line: string): void {
    const parsed = parseStreamLine(line);

    if (parsed.sessionId) {
      state.sessionId = parsed.sessionId;
      callbacks.onSessionId?.(parsed.sessionId);
      emit({
        type: 'call_session_id',
        ts: Date.now(),
        ...callbacks.context,
        nativeSessionId: parsed.sessionId,
      });
    }

    if (parsed.toolUse) {
      const toolLines = parsed.toolUse.map(formatToolUse).join('\n');
      callbacks.onOutput(toolLines + '\n');
      for (const toolUse of parsed.toolUse) {
        emit({
          type: 'call_tool_use_done',
          ts: Date.now(),
          ...callbacks.context,
          channel: 'tool',
          toolUse: { id: null, name: toolUse.name, input: toolUse.input },
        });
      }
    }

    if (parsed.text && !parsed.isResult) {
      state.text += parsed.text;
      state.sawAssistantText = true;
      emit({
        type: 'call_text_delta',
        ts: Date.now(),
        ...callbacks.context,
        channel: 'assistant',
        text: parsed.text,
      });
      callbacks.onOutput(parsed.text);

      if (callbacks.onQuestion && questionAccumulator) {
        const newQuestions = questionAccumulator.addChunk(parsed.text);
        if (newQuestions.length > 0) {
          callbacks.onQuestion(newQuestions);
        }
      }
    }

    if (parsed.isResult) {
      state.sawResult = true;
      if (parsed.text) {
        state.text = parsed.text;
        state.resultText = parsed.text;
        if (!state.sawAssistantText) {
          emit({
            type: 'call_text_delta',
            ts: Date.now(),
            ...callbacks.context,
            channel: 'result',
            text: parsed.text,
          });
        }
        callbacks.onOutput(parsed.text);
      }
    }

    if (parsed.isError) {
      state.isError = true;
      emit({
        type: 'call_error',
        ts: Date.now(),
        ...callbacks.context,
        status: 'failed',
        error: {
          code: 'runner_result_error',
          message: (state.resultText ?? state.text) || 'Claude result failed',
        },
      });
    }

    if (parsed.usage) {
      state.usage = parsed.usage;
      emit({
        type: 'call_usage',
        ts: Date.now(),
        ...callbacks.context,
        usage: parsed.usage,
        semantics: parsed.isResult ? 'final' : 'delta',
      });
    }
  }

  return { state, handleLine, emit };
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

function finishClaudeStream(
  state: StreamHandlerState,
  emit: (event: RunnerCallEvent) => void,
  context: RunnerCallContext,
): RunnerCallResult {
  if (!state.isError && state.sawResult) {
    emit({
      type: 'call_completed',
      ts: Date.now(),
      ...context,
      status: 'completed',
      usage: state.usage,
      nativeSessionId: state.sessionId,
    });
  }

  const result = collectRunnerCallResult(state.events);
  if (result.status !== 'completed') throwForClaudeCallFailure(result);
  return result;
}

function markInterruptedClaudeStream(
  state: StreamHandlerState,
  emit: (event: RunnerCallEvent) => void,
  context: RunnerCallContext,
  signal: AbortSignal | undefined,
): void {
  if (!signal?.aborted) return;
  emit({
    type: 'call_error',
    ts: Date.now(),
    ...context,
    status:
      signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
        ? 'timeout'
        : 'aborted',
    error: {
      code: 'runner_interrupted',
      message: signal.reason instanceof Error ? signal.reason.message : 'Claude stream interrupted',
    },
  });
  collectRunnerCallResult(state.events);
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
  const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];

  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (sessionId) args.push('--session-id', sessionId);
  return args;
}

interface ClaudePlannerStreamResult {
  text: string;
  sessionId: string | null;
  usage: TokenDelta | null;
}

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
  } = opts;
  const args = buildClaudeArgs({ sessionId, model, effort });

  const context = createClaudeCallContext({ role: 'planner', model });
  const { state, handleLine, emit } = createStreamHandler({
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
    markInterruptedClaudeStream(state, emit, context, signal);
    throw interruptedError(signal, err);
  }

  finishClaudeStream(state, emit, context);

  return { text: state.text, sessionId: state.sessionId, usage: state.usage };
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
  env?: NodeJS.ProcessEnv | undefined;
}

export async function runClaudeOneShot(opts: ClaudeOneShotOpts): Promise<InvokeResult> {
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
    env,
  } = opts;
  const context = createClaudeCallContext({
    role: permissionMode === 'acceptEdits' ? 'implementer' : 'planner',
    model,
  });
  const { state, handleLine, emit } = createStreamHandler({
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
    markInterruptedClaudeStream(state, emit, context, signal);
    throw interruptedError(signal, err);
  }

  finishClaudeStream(state, emit, context);

  return { text: state.text, usage: state.usage };
}
