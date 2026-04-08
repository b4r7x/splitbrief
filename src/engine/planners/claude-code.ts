import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PlannerTokenUsage } from '../../types.js';
import type { Planner, EscalationResult } from './types.js';
import { createPlannerBase, createGetVersion, createIsAvailable, type InvokeResult } from './base.js';
import { spawnWithStdin } from '../../utils/process.js';
import { parseStreamLine, type ToolUseInfo } from '../streaming/claude-stream.js';
import { validateTaskPath } from '../../utils/fs.js';
import { createQuestionAccumulator, type ClarificationQuestion } from '../parsers/question-parser.js';

const NOT_FOUND = 'Claude Code CLI not found. Install it from https://claude.ai/code';

interface StreamHandlerState {
  text: string;
  sessionId: string | null;
  usage: PlannerTokenUsage | null;
}

interface StreamHandlerCallbacks {
  onOutput: (text: string) => void;
  onSessionId?: (id: string) => void;
  onQuestion?: (questions: ClarificationQuestion[]) => void;
}

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

interface StreamResult {
  text: string;
  sessionId: string | null;
  usage: PlannerTokenUsage | null;
}

async function spawnClaudePlanner(
  prompt: string,
  projectDir: string,
  sessionId: string | null,
  onOutput: (text: string) => void,
  onQuestion?: (questions: ClarificationQuestion[]) => void,
  model?: string,
): Promise<StreamResult> {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (model) {
    args.push('--model', model);
  }
  if (sessionId) {
    args.push('--session-id', sessionId);
  }

  const { state, handleLine } = createStreamHandler({ onOutput, onQuestion });
  state.sessionId = sessionId;

  await spawnWithStdin({
    command: 'claude',
    args,
    cwd: projectDir,
    notFoundMessage: NOT_FOUND,
    onLine: handleLine,
  });

  return { text: state.text, sessionId: state.sessionId, usage: state.usage };
}

async function spawnClaudeWithStdin(
  prompt: string,
  projectDir: string,
  onOutput: (text: string) => void,
  model?: string,
): Promise<InvokeResult> {
  const { state, handleLine } = createStreamHandler({ onOutput });
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (model) {
    args.push('--model', model);
  }

  await spawnWithStdin({
    command: 'claude',
    args,
    cwd: projectDir,
    stdin: prompt,
    notFoundMessage: NOT_FOUND,
    onLine: handleLine,
  });

  return { text: state.text, usage: state.usage };
}

export function createClaudeCodePlanner(model?: string): Planner {
  let currentSessionId: string | null = null;

  return createPlannerBase({
    name: 'claude-code',
    pricingKey: 'claude-code',
    conversational: true,

    async invokePlan(prompt, projectDir, onOutput, onQuestion) {
      const result = await spawnClaudePlanner(prompt, projectDir, currentSessionId, onOutput, onQuestion, model);
      currentSessionId = result.sessionId;
      return { text: result.text, usage: result.usage };
    },

    async invokeEscalate(prompt, projectDir, onOutput) {
      return spawnClaudeWithStdin(prompt, projectDir, onOutput, model);
    },

    isAvailable: createIsAvailable('claude'),

    getVersion: createGetVersion('claude'),

    escalateHintSuccess: () => false,

    escalateFullPostProcess(task, result, extracted, projectDir): EscalationResult {
      const filePath = validateTaskPath(projectDir, task.file);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, extracted.code, 'utf-8');
      return { success: true, output: result.text, code: extracted.code, usage: result.usage };
    },
  });
}
