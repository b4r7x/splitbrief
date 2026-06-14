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
  isError: boolean;
}

interface StreamHandlerCallbacks {
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
}

function createStreamHandler(callbacks: StreamHandlerCallbacks) {
  const state: StreamHandlerState = {
    text: '',
    sessionId: null,
    usage: null,
    resultText: null,
    isError: false,
  };
  const questionAccumulator = callbacks.onQuestion ? createQuestionAccumulator() : null;

  function handleLine(line: string): void {
    const parsed = parseStreamLine(line);

    if (parsed.sessionId) {
      state.sessionId = parsed.sessionId;
      callbacks.onSessionId?.(parsed.sessionId);
    }

    if (parsed.toolUse) {
      const toolLines = parsed.toolUse.map(formatToolUse).join('\n');
      callbacks.onOutput(toolLines + '\n');
    }

    if (parsed.text) {
      state.text += parsed.text;
      callbacks.onOutput(parsed.text);

      if (callbacks.onQuestion && questionAccumulator) {
        const newQuestions = questionAccumulator.addChunk(parsed.text);
        if (newQuestions.length > 0) {
          callbacks.onQuestion(newQuestions);
        }
      }
    }

    if (parsed.isResult && parsed.text) {
      state.text = parsed.text;
      state.resultText = parsed.text;
    }

    if (parsed.isError) {
      state.isError = true;
    }

    if (parsed.usage) {
      state.usage = parsed.usage;
    }
  }

  return { state, handleLine };
}

function throwIfErrorResult(state: StreamHandlerState): void {
  if (!state.isError) return;
  throw processError.exitCode({
    command: 'claude',
    code: 0,
    stderr: '',
    output: state.resultText ?? state.text,
    detail: state.resultText ?? state.text,
  });
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
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  model?: string | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
}

export async function runClaudePlannerStream(
  opts: ClaudePlannerStreamOpts,
): Promise<ClaudePlannerStreamResult> {
  const { prompt, projectDir, sessionId, onOutput, onQuestion, model, effort, images, signal } =
    opts;
  const args = buildClaudeArgs({ sessionId, model, effort });

  const { state, handleLine } = createStreamHandler({ onOutput, onQuestion });
  state.sessionId = sessionId;

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

  throwIfErrorResult(state);

  return { text: state.text, sessionId: state.sessionId, usage: state.usage };
}

export interface ClaudeOneShotOpts {
  prompt: string;
  projectDir: string;
  onOutput: (text: string) => void;
  model?: string | undefined;
  effort?: EffortLevel | undefined;
  permissionMode?: 'acceptEdits' | undefined;
  signal?: AbortSignal | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export async function runClaudeOneShot(opts: ClaudeOneShotOpts): Promise<InvokeResult> {
  const { prompt, projectDir, onOutput, model, effort, permissionMode, signal, env } = opts;
  const { state, handleLine } = createStreamHandler({ onOutput });
  const args = buildClaudeArgs({ model, effort, permissionMode });

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

  throwIfErrorResult(state);

  return { text: state.text, usage: state.usage };
}
