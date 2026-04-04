import { spawn, type ChildProcess } from 'node:child_process';
import type { Config } from '../../types.js';
import type { ImplementerOptions, RetryOptions } from './base.js';
import type { ImplementerBackend } from './types.js';
import type { InvokeOpts } from './base.js';
import { createImplementerBase } from './base.js';
import { buildFullPrompt, buildFullRetryPrompt } from '../spec/formatter.js';
import { registerProcess, unregisterProcess, isENOENT, killProcess } from '../../utils/process.js';
import { getGit } from '../../utils/git.js';

const DEFAULT_TIMEOUT = 300_000;

interface SpawnAgentOptions {
  command: string;
  args: string[];
  prompt: string;
  projectDir: string;
  timeout: number;
  useStdin: boolean;
  onProgress: (text: string) => void;
}

interface SpawnAgentResult {
  output: string;
  code: number;
  timedOut: boolean;
  stderr: string;
}

function substitutePrompt(args: string[], prompt: string): { args: string[]; useStdin: boolean } {
  const hasPlaceholder = args.some(a => a.includes('{prompt}'));
  if (!hasPlaceholder) return { args, useStdin: true };
  return {
    args: args.map(a => a.replace('{prompt}', prompt)),
    useStdin: false,
  };
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

function spawnAgent(opts: SpawnAgentOptions): Promise<SpawnAgentResult> {
  const { command, args, prompt, projectDir, timeout, useStdin, onProgress } = opts;
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

    if (useStdin) {
      proc.stdin?.write(prompt);
    }
    proc.stdin?.end();
  });
}

async function spawnWithShellFallback(opts: SpawnAgentOptions): Promise<SpawnAgentResult> {
  try {
    return await spawnAgent(opts);
  } catch (err: unknown) {
    if (!isENOENT(err)) throw err;

    const userShell = process.env['SHELL'] ?? '/bin/bash';
    const fullCommand = [opts.command, ...opts.args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    return spawnAgent({ ...opts, command: userShell, args: ['-lc', fullCommand] });
  }
}

function interpretAgentResult(
  result: SpawnAgentResult,
  timeout: number,
  command: string,
): { success: boolean; output: string; error?: string } {
  if (result.code === 127) {
    throw new Error(`Agent implementer command not found: ${command}`);
  }
  if (result.timedOut) {
    return { success: false, output: result.output, error: `Agent implementer timed out after ${Math.round(timeout / 1000)}s` };
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    return { success: false, output: result.output, error: `Agent implementer exited with code ${result.code}${detail ? `: ${detail}` : ''}` };
  }
  return { success: true, output: result.output };
}

function agentError(message: string, output: string): Error & { output: string } {
  const err = new Error(message) as Error & { output: string };
  err.output = output;
  return err;
}

export function createAgentImplementer(config: Config): ImplementerBackend {
  return createImplementerBase({
    name: 'agent',
    pricingKey: config.implementer.provider,
    extractsCode: false,


    buildPrompt(opts: ImplementerOptions) {
      return buildFullPrompt(opts.task, opts.context, opts.config.implementer.contextLength);
    },

    buildRetryPrompt(opts: RetryOptions) {
      return buildFullRetryPrompt(opts.task, opts.context, opts.error, opts.attempt, opts.config.implementer.contextLength);
    },

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, config: cfg, onProgress } = opts;
      const command = cfg.implementer.command!;
      const rawArgs = cfg.implementer.args ?? [];
      const timeout = cfg.implementer.timeout ?? DEFAULT_TIMEOUT;

      const { args, useStdin } = substitutePrompt(rawArgs, prompt);

      let result: SpawnAgentResult;
      try {
        result = await spawnWithShellFallback({ command, args, prompt, projectDir, timeout, useStdin, onProgress });
      } catch (err) {
        if (isENOENT(err)) throw new Error(`Agent implementer command not found: ${command}`);
        throw err;
      }

      const interpreted = interpretAgentResult(result, timeout, command);
      if (!interpreted.success) {
        throw agentError(interpreted.error!, interpreted.output);
      }

      return { text: result.output };
    },

    async detectChanges(projectDir: string) {
      const changedFiles = await getChangedFiles(projectDir);
      if (changedFiles.length === 0) {
        return { changed: false, output: 'Agent implementer exited without changing any files' };
      }
      return { changed: true, output: '' };
    },

    shouldThrow(err: unknown) {
      return err instanceof Error && err.message.includes('command not found');
    },

    async isAvailable() {
      return true;
    },
  });
}

