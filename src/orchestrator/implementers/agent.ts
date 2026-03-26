import { spawn, type ChildProcess } from 'node:child_process';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { Task, Config, ProjectContext } from '../../types.js';
import { formatTaskPrompt, formatRetryPrompt, SYSTEM_PREAMBLE } from '../../spec/formatter.js';
import { activeProcesses } from '../../utils/process.js';

const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const SIGKILL_DELAY = 5_000;

function buildPrompt(task: Task, context: ProjectContext, contextLength?: number): string {
  return SYSTEM_PREAMBLE + '\n\n' + formatTaskPrompt(task, context, contextLength);
}

function buildRetryPrompt(task: Task, context: ProjectContext, error: string, attempt: number): string {
  return SYSTEM_PREAMBLE + '\n\n' + formatRetryPrompt(task, context, error, attempt);
}

function substitutePrompt(args: string[], prompt: string): { args: string[]; useStdin: boolean } {
  const hasPlaceholder = args.some(a => a.includes('{prompt}'));
  if (!hasPlaceholder) return { args, useStdin: true };
  return {
    args: args.map(a => a.replace('{prompt}', prompt)),
    useStdin: false,
  };
}

function killProcessGroup(proc: ChildProcess): void {
  if (!proc.pid || proc.exitCode !== null) return;
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    // already exited
  }
  setTimeout(() => {
    try {
      process.kill(-proc.pid!, 0); // check alive
      process.kill(-proc.pid!, 'SIGKILL');
    } catch {
      // already dead
    }
  }, SIGKILL_DELAY);
}

async function getChangedFiles(projectDir: string): Promise<string[]> {
  const git = (simpleGit as unknown as (dir: string) => SimpleGit)(projectDir);
  const status = await git.status();
  return [
    ...status.modified,
    ...status.not_added,
    ...status.created,
    ...status.deleted,
  ];
}

function spawnAgent(
  command: string,
  args: string[],
  prompt: string,
  projectDir: string,
  timeout: number,
  useStdin: boolean,
  onProgress: (text: string) => void,
): Promise<{ output: string; code: number; timedOut: boolean }> {
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

    activeProcesses.add(proc);

    let output = '';
    let stderrOutput = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(proc);
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
      activeProcesses.delete(proc);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      resolve({ output, code: code ?? 1, timedOut });
    });

    if (useStdin) {
      proc.stdin?.write(prompt);
      proc.stdin?.end();
    } else {
      proc.stdin?.end();
    }
  });
}

async function spawnWithShellFallback(
  command: string,
  args: string[],
  prompt: string,
  projectDir: string,
  timeout: number,
  useStdin: boolean,
  onProgress: (text: string) => void,
): Promise<{ output: string; code: number; timedOut: boolean }> {
  try {
    return await spawnAgent(command, args, prompt, projectDir, timeout, useStdin, onProgress);
  } catch (err: unknown) {
    const errObj = err as NodeJS.ErrnoException;
    if (errObj.code !== 'ENOENT') throw err;

    // Fallback: try through user's login shell
    const userShell = process.env['SHELL'] ?? '/bin/bash';
    const fullCommand = [command, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    return spawnAgent(userShell, ['-lc', fullCommand], prompt, projectDir, timeout, useStdin, onProgress);
  }
}

async function runAgentImplementer(
  prompt: string,
  projectDir: string,
  config: Config,
  onProgress: (text: string) => void,
): Promise<{ success: boolean; output: string; error?: string; usage?: { promptTokens: number; completionTokens: number } }> {
  const command = config.implementer.command!;
  const rawArgs = config.implementer.args ?? [];
  const timeout = config.implementer.timeout ?? DEFAULT_TIMEOUT;

  const { args, useStdin } = substitutePrompt(rawArgs, prompt);

  let result: { output: string; code: number; timedOut: boolean };
  try {
    result = await spawnWithShellFallback(command, args, prompt, projectDir, timeout, useStdin, onProgress);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Agent implementer command not found: ${command}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: msg };
  }

  if (result.code === 127) {
    throw new Error(`Agent implementer command not found: ${command}`);
  }

  if (result.timedOut) {
    return { success: false, output: result.output, error: `Agent implementer timed out after ${Math.round(timeout / 1000)}s` };
  }

  // Check if agent changed any files
  const changedFiles = await getChangedFiles(projectDir);
  if (changedFiles.length === 0) {
    return {
      success: false,
      output: result.output,
      error: 'Agent implementer exited without changing any files',
    };
  }

  return { success: true, output: result.output };
}

export async function implementTaskViaAgent(
  task: Task,
  projectDir: string,
  config: Config,
  context: ProjectContext,
  onProgress: (text: string) => void,
): Promise<{ success: boolean; output: string; error?: string; usage?: { promptTokens: number; completionTokens: number } }> {
  const prompt = buildPrompt(task, context, config.implementer.contextLength);
  return runAgentImplementer(prompt, projectDir, config, onProgress);
}

export async function retryTaskViaAgent(
  task: Task,
  projectDir: string,
  config: Config,
  context: ProjectContext,
  error: string,
  attempt: number,
  onProgress: (text: string) => void,
): Promise<{ success: boolean; output: string; error?: string; usage?: { promptTokens: number; completionTokens: number } }> {
  const prompt = buildRetryPrompt(task, context, error, attempt);
  return runAgentImplementer(prompt, projectDir, config, onProgress);
}
