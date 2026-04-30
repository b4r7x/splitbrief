import type { InvokeResult } from './runners/types.js';
import type { TokenDelta } from '../core/schemas/tokens.js';
import type { ClarificationQuestion } from '../core/schemas/question.js';
import type { EffortLevel } from '../core/schemas/enums.js';
import type { Attachment } from '../core/schemas/attachment.js';
import { spawnWithStdin } from '../lib/process/spawn.js';
import { parseStreamLine, type ToolUseInfo } from './streaming/output-parsers.js';
import { createQuestionAccumulator } from './parsers/question-parser.js';

const CLAUDE_NOT_FOUND = 'Claude Code CLI not found. Install it from https://claude.ai/code';

interface ToolFormat {
  field: string;
  quoted?: boolean;
  maxLen?: number;
}

const TOOL_FORMATS: Record<string, ToolFormat> = {
  Read:         { field: 'file_path' },
  Write:        { field: 'file_path' },
  Edit:         { field: 'file_path' },
  Glob:         { field: 'pattern' },
  Skill:        { field: 'skill' },
  NotebookEdit: { field: 'file_path' },
  Grep:         { field: 'pattern', quoted: true },
  WebSearch:    { field: 'query', quoted: true },
  ToolSearch:   { field: 'query', quoted: true },
  Bash:         { field: 'command', maxLen: 60 },
  WebFetch:     { field: 'url', maxLen: 80 },
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

  const hint = Object.values(tool.input).find(v => typeof v === 'string');
  return `→ ${tool.name}${hint ? ' ' + String(hint).slice(0, 60) : ''}`;
}

interface StreamHandlerState {
  text: string;
  sessionId: string | null;
  usage: TokenDelta | null;
}

interface StreamHandlerCallbacks {
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
}

function createStreamHandler(callbacks: StreamHandlerCallbacks) {
  const state: StreamHandlerState = { text: '', sessionId: null, usage: null };
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
    }

    if (parsed.usage) {
      state.usage = parsed.usage;
    }
  }

  return { state, handleLine };
}

interface BuildArgsOpts {
  prompt?: string | undefined;
  sessionId?: string | null;
  model?: string | undefined;
  useStdin?: boolean | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
}

export function applyEffortPrefix(prompt: string, effort: EffortLevel | undefined): string {
  if (!effort) return prompt;
  return `/effort ${effort}\n\n${prompt}`;
}

function buildClaudeArgs(opts: BuildArgsOpts): string[] {
  const { prompt, sessionId, model, useStdin, effort, images } = opts;
  const effectivePrompt = applyEffortPrefix(prompt ?? '', effort);
  const args: string[] = useStdin
    ? ['-p', '--output-format', 'stream-json', '--verbose']
    : ['-p', effectivePrompt, '--output-format', 'stream-json', '--verbose'];

  if (model) args.push('--model', model);
  if (sessionId) args.push('--session-id', sessionId);
  if (images) {
    for (const img of images) {
      args.push('--image', img.path);
    }
  }
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
}

export async function runClaudePlannerStream(opts: ClaudePlannerStreamOpts): Promise<ClaudePlannerStreamResult> {
  const { prompt, projectDir, sessionId, onOutput, onQuestion, model, effort, images } = opts;
  const args = buildClaudeArgs({ prompt, sessionId, model, effort, ...(images ? { images } : {}) });

  const { state, handleLine } = createStreamHandler({ onOutput, onQuestion });
  state.sessionId = sessionId;

  await spawnWithStdin({
    command: 'claude',
    args,
    cwd: projectDir,
    notFoundMessage: CLAUDE_NOT_FOUND,
    onLine: handleLine,
  });

  return { text: state.text, sessionId: state.sessionId, usage: state.usage };
}

export interface ClaudeOneShotOpts {
  prompt: string;
  projectDir: string;
  onOutput: (text: string) => void;
  model?: string | undefined;
  effort?: EffortLevel | undefined;
}

export async function runClaudeOneShot(opts: ClaudeOneShotOpts): Promise<InvokeResult> {
  const { prompt, projectDir, onOutput, model, effort } = opts;
  const { state, handleLine } = createStreamHandler({ onOutput });
  const args = buildClaudeArgs({ useStdin: true, model, effort });

  await spawnWithStdin({
    command: 'claude',
    args,
    cwd: projectDir,
    stdin: applyEffortPrefix(prompt, effort),
    notFoundMessage: CLAUDE_NOT_FOUND,
    onLine: handleLine,
  });

  return { text: state.text, usage: state.usage };
}
