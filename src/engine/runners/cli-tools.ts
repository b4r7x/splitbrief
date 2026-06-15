import type { ParsedLine } from './types.js';
import { confinedExists } from '../../lib/confined-fs.js';
import { parseJsonlLine } from '../streaming/parse-jsonl.js';
import { parseCopilotLine } from '../streaming/parse-copilot.js';
import { parseOpencodeLine } from '../streaming/parse-opencode.js';
import { parseTextLine } from '../streaming/parse-text.js';
import type { CliToolId, EffortLevel } from '../../core/schemas/enums.js';
import type { InvokeResult } from './types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';

const MAX_ARGV_PROMPT_BYTES = 120_000;
const TRUNCATION_NOTICE =
  '\n\n[diptych: prompt truncated to fit the OS argv limit — earlier context above is complete; trailing content was dropped]';

function clampPromptForArgv(prompt: string): string {
  if (Buffer.byteLength(prompt, 'utf8') <= MAX_ARGV_PROMPT_BYTES) return prompt;
  const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');
  const headBudget = MAX_ARGV_PROMPT_BYTES - noticeBytes;
  const head = Buffer.from(prompt, 'utf8')
    .subarray(0, headBudget)
    .toString('utf8')
    .replace(/�+$/, '');
  return head + TRUNCATION_NOTICE;
}

export interface CliToolPlanner {
  buildArgs(opts: {
    prompt: string;
    model?: string | undefined;
    projectDir: string;
    mode: 'plan' | 'escalate';
    sessionId?: string | null | undefined;
    effort?: EffortLevel | undefined;
  }): string[];
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
  parseLine?: ((line: string) => ParsedLine) | undefined;
}

export interface CliToolEntry {
  command: string;
  description: string;
  notFoundMessage: string;
  /**
   * Upstream CLI version diptych's flag/subcommand/JSON contract was last verified against.
   * `detectAvailablePlanners` warns when the installed major version differs, since these
   * tools ship breaking CLI changes with no compatibility guarantee. Tested matrix lives in
   * docs/PLANNERS-AND-IMPLEMENTERS.md.
   */
  testedVersion: string;
  planner?: CliToolPlanner;
  implementer?: CliToolImplementer;
}

export const CLI_TOOLS: Record<CliToolId, CliToolEntry> = {
  'claude-code': {
    command: 'claude',
    description: 'Claude Code CLI',
    notFoundMessage: 'Claude Code CLI not found. Install it from https://claude.ai/code',
    testedVersion: '2.0.0',
  },
  codex: {
    command: 'codex',
    description: 'OpenAI Codex CLI',
    notFoundMessage: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
    testedVersion: '0.40.0',
    planner: {
      supportsSessionResume: true,
      supportsEffort: false,
      buildArgs: ({ prompt: rawPrompt, model, projectDir, mode, sessionId }) => {
        const prompt = clampPromptForArgv(rawPrompt);
        // Resume path: `codex exec resume --json <SESSION_ID> <PROMPT>`. Only valid for live
        // planning turns; escalate uses one-shot `exec` to avoid polluting the resumed session.
        if (sessionId && mode === 'plan') {
          const args = ['exec', 'resume', '--json', sessionId, prompt];
          if (model) args.splice(2, 0, '--model', model);
          return args;
        }
        const args =
          mode === 'plan'
            ? ['exec', '--json', '--cd', projectDir, prompt]
            : [
                'exec',
                '--json',
                '--sandbox',
                'workspace-write',
                '--skip-git-repo-check',
                '--cd',
                projectDir,
                prompt,
              ];
        if (model) args.unshift('--model', model);
        return args;
      },
      parseLine: parseJsonlLine,
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args: string[] = [
          'exec',
          '--json',
          '--sandbox',
          'workspace-write',
          '--skip-git-repo-check',
          clampPromptForArgv(prompt),
        ];
        if (model) args.unshift('--model', model);
        return args;
      },
      parseLine: parseJsonlLine,
    },
  },
  opencode: {
    command: 'opencode',
    description: 'OpenCode CLI',
    notFoundMessage: 'OpenCode CLI not found. Install it from https://opencode.ai',
    testedVersion: '0.5.0',
    planner: {
      buildArgs: ({ prompt, model }) => {
        const args = ['run', '--format', 'json', '--agent', 'plan', clampPromptForArgv(prompt)];
        if (model) args.splice(1, 0, '--model', model);
        return args;
      },
      parseLine: parseOpencodeLine,
      isAvailableOpts: { timeout: 5000 },
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args = ['run', clampPromptForArgv(prompt)];
        if (model) args.splice(1, 0, '--model', model);
        return args;
      },
    },
  },
  aider: {
    command: 'aider',
    description: 'Aider CLI',
    notFoundMessage: 'Aider not found. Install it from https://aider.chat',
    testedVersion: '0.86.0',
    planner: {
      buildArgs: ({ prompt, model, projectDir, mode }) => {
        const args = [
          '--chat-mode',
          'ask',
          '--yes-always',
          '--no-stream',
          '--no-pretty',
          '--message',
          clampPromptForArgv(prompt),
        ];
        if (model) args.unshift('--model', model);
        if (mode === 'plan' && confinedExists(projectDir, 'src')) args.push('--read', 'src/');
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
        const args = [
          '--message',
          clampPromptForArgv(prompt),
          '--yes-always',
          '--no-auto-commits',
          '--no-dirty-commits',
        ];
        if (model) args.push('--model', model);
        return args;
      },
    },
  },
  copilot: {
    command: 'copilot',
    description: 'GitHub Copilot CLI',
    notFoundMessage:
      'Copilot CLI not found. Install: npm install -g @github/copilot — or see https://github.com/github/copilot-cli',
    testedVersion: '0.3.0',
    planner: {
      buildArgs: ({ prompt, model }) => {
        const args = ['-p', clampPromptForArgv(prompt), '--output-format', 'json'];
        if (model) args.unshift('--model', model);
        return args;
      },
      parseLine: parseCopilotLine,
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args = ['-p', clampPromptForArgv(prompt), '--allow-all'];
        if (model) args.unshift('--model', model);
        return args;
      },
    },
  },
  'kilo-code': {
    command: 'kilo',
    description: 'Kilo Code CLI',
    notFoundMessage: 'Kilo Code CLI not found. Install it with: npm install -g @kilocode/cli',
    testedVersion: '0.1.0',
    planner: {
      buildArgs: ({ prompt, model }) => {
        const args = [
          'run',
          '--format',
          'json',
          '--agent',
          'architect',
          clampPromptForArgv(prompt),
        ];
        if (model) args.splice(1, 0, '--model', model);
        return args;
      },
      parseLine: parseOpencodeLine,
      isAvailableOpts: { timeout: 5000 },
    },
    implementer: {
      buildArgs: ({ prompt, model }) => {
        const args = ['run', '--auto', clampPromptForArgv(prompt)];
        if (model) args.splice(1, 0, '--model', model);
        return args;
      },
    },
  },
};
