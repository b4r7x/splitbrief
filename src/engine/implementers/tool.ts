import { spawn, type ChildProcess } from 'node:child_process';
import type { Config } from '../../types.js';
import type { ImplementerOptions, RetryOptions, InvokeOpts } from './base.js';
import type { ImplementerBackend } from './types.js';
import { createImplementerBase } from './base.js';
import { buildFullPrompt, buildFullRetryPrompt } from '../spec/formatter.js';
import { registerProcess, unregisterProcess, isENOENT, killProcess, runCommand } from '../../utils/process.js';
import { getGit } from '../../utils/git.js';

export type ToolName = 'claude-code' | 'codex' | 'opencode' | 'aider';

interface ToolConfig {
  command: string;
  buildArgs: (prompt: string, model?: string) => string[];
  notFoundMessage: string;
}

const TOOL_CONFIGS: Record<ToolName, ToolConfig> = {
  'claude-code': {
    command: 'claude',
    buildArgs: (prompt, model) => {
      const args = ['--print', '--output-format', 'text', '-p', prompt];
      if (model) args.push('--model', model);
      return args;
    },
    notFoundMessage: 'Claude Code CLI not found. Install it from https://claude.ai/code',
  },
  codex: {
    command: 'codex',
    buildArgs: (prompt, model) => {
      const args: string[] = ['--quiet', '--full-auto', '-p', prompt];
      if (model) args.push('--model', model);
      return args;
    },
    notFoundMessage: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
  },
  opencode: {
    command: 'opencode',
    buildArgs: (prompt, model) => {
      const args = [prompt];
      if (model) args.push('--model', model);
      return args;
    },
    notFoundMessage: 'OpenCode CLI not found. Install it from https://opencode.ai',
  },
  aider: {
    command: 'aider',
    buildArgs: (prompt, model) => {
      const args = ['--message', prompt, '--yes-always'];
      if (model) args.push('--model', model);
      return args;
    },
    notFoundMessage: 'Aider not found. Install it from https://aider.chat',
  },
};

export const TOOL_NAMES = Object.keys(TOOL_CONFIGS) as ToolName[];

interface SpawnToolResult {
  output: string;
  code: number;
  timedOut: boolean;
  stderr: string;
}

const DEFAULT_TIMEOUT = 300_000;

function spawnTool(
  command: string,
  args: string[],
  projectDir: string,
  timeout: number,
  onProgress: (text: string) => void,
): Promise<SpawnToolResult> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(command, args, {
        cwd: projectDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err: unknown) {
      reject(err);
      return;
    }

    registerProcess(proc);

    let output = '';
    let stderrOutput = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcess(proc, { group: true });
    }, timeout);

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      onProgress(text);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      unregisterProcess(proc);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      unregisterProcess(proc);
      resolve({ output, code: code ?? 1, timedOut, stderr: stderrOutput });
    });

    proc.stdin?.end();
  });
}

async function getChangedFiles(projectDir: string): Promise<string[]> {
  const git = getGit(projectDir);
  const status = await git.status();
  return [
    ...status.modified,
    ...status.not_added,
    ...status.created,
    ...status.deleted,
  ];
}

function toolError(message: string, output: string): Error & { output: string } {
  const err = new Error(message) as Error & { output: string };
  err.output = output;
  return err;
}

export function createToolImplementer(toolName: string, config: Config): ImplementerBackend {
  const toolConfig = TOOL_CONFIGS[toolName as ToolName];
  if (!toolConfig) {
    throw new Error(`Unknown tool implementer: ${toolName}. Supported: ${TOOL_NAMES.join(', ')}`);
  }

  const model = config.implementer.model || config.planner.model;
  const timeout = config.implementer.timeout ?? DEFAULT_TIMEOUT;

  return createImplementerBase({
    name: `tool:${toolName}`,
    pricingKey: toolName,
    extractsCode: false,

    buildPrompt(opts: ImplementerOptions) {
      return buildFullPrompt(opts.task, opts.context, opts.config.implementer.contextLength);
    },

    buildRetryPrompt(opts: RetryOptions) {
      return buildFullRetryPrompt(opts.task, opts.context, opts.error, opts.attempt, opts.config.implementer.contextLength);
    },

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onProgress } = opts;
      const effectiveModel = opts.config.implementer.model || opts.config.planner.model;
      const args = toolConfig.buildArgs(prompt, effectiveModel);

      let result: SpawnToolResult;
      try {
        result = await spawnTool(toolConfig.command, args, projectDir, timeout, onProgress);
      } catch (err) {
        if (isENOENT(err)) throw new Error(toolConfig.notFoundMessage);
        throw err;
      }

      if (result.code === 127) {
        throw new Error(toolConfig.notFoundMessage);
      }
      if (result.timedOut) {
        throw toolError(`Tool implementer (${toolName}) timed out after ${Math.round(timeout / 1000)}s`, result.output);
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim();
        throw toolError(
          `Tool implementer (${toolName}) exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
          result.output,
        );
      }

      return { text: result.output };
    },

    async detectChanges(projectDir: string) {
      const changedFiles = await getChangedFiles(projectDir);
      if (changedFiles.length === 0) {
        return { changed: false, output: `Tool implementer (${toolName}) exited without changing any files` };
      }
      return { changed: true, output: '' };
    },

    shouldThrow(err: unknown) {
      return err instanceof Error && (
        err.message.includes('not found') ||
        err.message.includes('timed out')
      );
    },

    async isAvailable() {
      try {
        const { code } = await runCommand(toolConfig.command, ['--version']);
        return code === 0;
      } catch {
        return false;
      }
    },
  });
}
