import type { ParsedLine } from '../core/types/backends.js';
import { parseJsonlLine, parseOpencodeLine, parseTextLine } from './streaming/output-parsers.js';
import type { CliPlannerTool, InvokeResult, TokenDelta } from '../types.js';

export interface CliToolPlanner {
  buildArgs(opts: { prompt: string; model?: string | undefined; projectDir: string; mode: 'plan' | 'escalate' }): string[];
  parseLine: (line: string) => ParsedLine;
  postProcess?: (text: string, stderrOutput: string, usage: TokenDelta | null) => InvokeResult;
  isAvailableOpts?: { timeout?: number | undefined };
}

export interface CliToolImplementer {
  buildArgs(opts: { prompt: string; model?: string | undefined }): string[];
}

export interface CliToolEntry {
  command: string;
  description: string;
  notFoundMessage: string;
  planner?: CliToolPlanner;
  implementer?: CliToolImplementer;
}

export const CLI_TOOLS: Record<CliPlannerTool, CliToolEntry> = {
  'claude-code': {
    command: 'claude',
    description: 'Claude Code CLI',
    notFoundMessage: 'Claude Code CLI not found. Install it from https://claude.ai/code',
    // No `implementer` field: claude-code implementer is handled by `runClaudeOneShot`
    // in `src/engine/claude-runner.ts` (stream-json parsing, tool-use formatting), not via
    // the generic CLI buildArgs path. See `src/engine/implementers/tool.ts`.
  },
  codex: {
    command: 'codex',
    description: 'OpenAI Codex CLI',
    notFoundMessage: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
    planner: {
      buildArgs: ({ prompt, model, projectDir }) => {
        const args = ['exec', '--json', '--full-auto', '--cd', projectDir, prompt];
        if (model) args.unshift('--model', model);
        return args;
      },
      parseLine: parseJsonlLine,
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args: string[] = ['--quiet', '--full-auto', '-p', prompt];
        if (model) args.push('--model', model);
        return args;
      },
    },
  },
  opencode: {
    command: 'opencode',
    description: 'OpenCode CLI',
    notFoundMessage: 'OpenCode CLI not found. Install it from https://opencode.ai',
    planner: {
      buildArgs: ({ prompt, model }) => {
        const args = ['run', '--format', 'json', '--agent', 'plan', prompt];
        if (model) args.splice(1, 0, '--model', model);
        return args;
      },
      parseLine: parseOpencodeLine,
      isAvailableOpts: { timeout: 5000 },
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args = [prompt];
        if (model) args.push('--model', model);
        return args;
      },
    },
  },
  aider: {
    command: 'aider',
    description: 'Aider CLI',
    notFoundMessage: 'Aider not found. Install it from https://aider.chat',
    planner: {
      buildArgs: ({ prompt, model, mode }) => {
        const args = ['--chat-mode', 'ask', '--yes-always', '--no-stream', '--no-pretty', '--message', prompt];
        if (model) args.unshift('--model', model);
        if (mode === 'plan') args.push('--read', 'src/');
        return args;
      },
      parseLine: (line) => ({ text: line + '\n' }),
      postProcess: (text, stderrOutput, usage) => {
        const allOutput = text + stderrOutput;
        for (const line of allOutput.split('\n')) {
          const parsed = parseTextLine(line);
          if (parsed.usage) return { text: text.trim(), usage: parsed.usage };
        }
        return { text: text.trim(), usage };
      },
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args = ['--message', prompt, '--yes-always'];
        if (model) args.push('--model', model);
        return args;
      },
    },
  },
};
