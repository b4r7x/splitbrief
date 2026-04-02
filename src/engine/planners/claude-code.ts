import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PlannerTokenUsage } from '../../types.js';
import type { PlannerBackend, EscalationResult } from './types.js';
import { createPlannerBase, createGetVersion, createIsAvailable, type InvokeResult } from './base.js';
import { spawnWithStdin } from './spawn.js';
import { spawnWithStreaming, isENOENT } from '../../utils/process.js';
import { parseStreamLine } from '../claude-stream.js';
import { validateTaskPath } from '../../utils/fs.js';
import { createQuestionAccumulator, type ClarificationQuestion } from '../question-parser.js';

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

function createStreamHandler(callbacks: StreamHandlerCallbacks) {
  const state: StreamHandlerState = { text: '', sessionId: null, usage: null };
  const questionAccumulator = callbacks.onQuestion ? createQuestionAccumulator() : null;

  function handleLine(line: string): void {
    const parsed = parseStreamLine(line);

    if (parsed.sessionId) {
      state.sessionId = parsed.sessionId;
      callbacks.onSessionId?.(parsed.sessionId);
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

// NOTE: The ENOENT/exit-127/non-zero error handling below duplicates spawnWithStdin (spawn.ts).
// This function uses spawnWithStreaming instead because it needs session-id tracking via
// the stream handler, which spawnWithStdin doesn't support.
async function spawnClaudePlanner(
  prompt: string,
  projectDir: string,
  sessionId: string | null,
  onOutput: (text: string) => void,
  onQuestion?: (questions: ClarificationQuestion[]) => void,
): Promise<StreamResult> {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (sessionId) {
    args.push('--session-id', sessionId);
  }

  const { state, handleLine } = createStreamHandler({ onOutput, onQuestion });
  state.sessionId = sessionId;
  let stderrOutput = '';

  let result: { code: number; killed: boolean };
  try {
    result = await spawnWithStreaming(
      'claude',
      args,
      handleLine,
      (line) => {
        stderrOutput += line + '\n';
      },
      { cwd: projectDir },
    );
  } catch (err: unknown) {
    if (isENOENT(err)) {
      throw new Error(NOT_FOUND);
    }
    throw err;
  }

  if (result.code === 127) {
    throw new Error(NOT_FOUND);
  }

  if (result.code !== 0 && !state.text) {
    const detail = stderrOutput.trim();
    throw new Error(
      `Claude CLI exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
    );
  }

  return { text: state.text, sessionId: state.sessionId, usage: state.usage };
}

async function spawnClaudeWithStdin(
  prompt: string,
  projectDir: string,
  onOutput: (text: string) => void,
): Promise<InvokeResult> {
  const { state, handleLine } = createStreamHandler({ onOutput });

  await spawnWithStdin({
    command: 'claude',
    args: ['-p', '--output-format', 'stream-json', '--verbose'],
    cwd: projectDir,
    stdin: prompt,
    notFoundMessage: NOT_FOUND,
    onLine: handleLine,
  });

  return { text: state.text, usage: state.usage };
}

export function createClaudeCodePlanner(): PlannerBackend {
  let currentSessionId: string | null = null;

  return createPlannerBase({
    name: 'claude-code',
    pricingKey: 'claude-code',
    conversational: true,

    async invokePlan(prompt, projectDir, onOutput, onQuestion) {
      const result = await spawnClaudePlanner(prompt, projectDir, currentSessionId, onOutput, onQuestion);
      currentSessionId = result.sessionId;
      return { text: result.text, usage: result.usage };
    },

    async invokeEscalate(prompt, projectDir, onOutput) {
      return spawnClaudeWithStdin(prompt, projectDir, onOutput);
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
