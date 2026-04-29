import type { ParsedLine } from './runners/types.js';
import { parseJsonlLine, parseOpencodeLine, parseTextLine } from './streaming/output-parsers.js';
import type { CliToolId, EffortLevel } from '../core/schemas/enums.js';
import type { InvokeResult } from './runners/types.js';
import type { TokenDelta } from '../core/schemas/tokens.js';

export interface CliToolPlanner {
  buildArgs(opts: { prompt: string; model?: string | undefined; projectDir: string; mode: 'plan' | 'escalate'; sessionId?: string | null | undefined; effort?: EffortLevel | undefined }): string[];
  parseLine: (line: string) => ParsedLine;
  postProcess?: (text: string, stderrOutput: string, usage: TokenDelta | null) => InvokeResult;
  isAvailableOpts?: { timeout?: number | undefined };
  /** Whether this tool supports resuming a previous session via a backend-specific flag. */
  supportsSessionResume?: boolean;
  /** Whether this CLI tool honours the planner-effort flag. */
  supportsEffort?: boolean;
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

export const CLI_TOOLS: Record<CliToolId, CliToolEntry> = {
  'claude-code': {
    command: 'claude',
    description: 'Claude Code CLI',
    notFoundMessage: 'Claude Code CLI not found. Install it from https://claude.ai/code',
  },
  codex: {
    command: 'codex',
    description: 'OpenAI Codex CLI',
    notFoundMessage: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
    planner: {
      supportsSessionResume: true,
      supportsEffort: false,
      buildArgs: ({ prompt, model, projectDir, mode, sessionId }) => {
        // Resume path: `codex exec resume --json <SESSION_ID> <PROMPT>`. Only valid for live
        // planning turns; escalate uses one-shot `exec` to avoid polluting the resumed session.
        if (sessionId && mode === 'plan') {
          const args = ['exec', 'resume', '--json', sessionId, prompt];
          if (model) args.splice(2, 0, '--model', model);
          return args;
        }
        const args = ['exec', '--json', '--full-auto', '--cd', projectDir, prompt];
        if (model) args.unshift('--model', model);
        return args;
      },
      parseLine: parseJsonlLine,
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args: string[] = ['exec', '--json', '--full-auto', prompt];
        if (model) args.unshift('--model', model);
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
  copilot: {
    command: 'copilot',
    description: 'GitHub Copilot CLI',
    notFoundMessage: 'Copilot CLI not found. Install: npm install -g @github/copilot — or see https://github.com/github/copilot-cli',
    planner: {
      buildArgs: ({ prompt, model }) => {
        const args = ['-p', prompt, '--output-format', 'json', '--allow-all'];
        if (model) args.unshift('--model', model);
        return args;
      },
      parseLine: parseJsonlLine,
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args = ['-p', prompt, '--allow-all'];
        if (model) args.unshift('--model', model);
        return args;
      },
    },
  },
  'kilo-code': {
    command: 'kilo',
    description: 'Kilo Code CLI',
    notFoundMessage: 'Kilo Code CLI not found. Install it with: npm install -g @kilocode/cli',
    planner: {
      buildArgs: ({ prompt, model }) => {
        const args = ['run', '--auto', '--json', '-m', 'architect', prompt];
        if (model) args.push('--model', model);
        return args;
      },
      parseLine: parseJsonlLine,
      isAvailableOpts: { timeout: 5000 },
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args = ['run', '--auto', '--yolo', prompt];
        if (model) args.push('--model', model);
        return args;
      },
    },
  },
};
