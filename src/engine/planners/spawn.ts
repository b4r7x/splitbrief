import { spawn } from 'node:child_process';
import { registerProcess, unregisterProcess, isENOENT, createLineBuffer } from '../../utils/process.js';
import type { PlannerTokenUsage } from '../../types.js';
import { accumulateUsage } from '../output-parsers.js';

export async function spawnWithStdin(opts: {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  onLine: (line: string) => void;
  onStderr?: (chunk: string) => void;
  notFoundMessage: string;
}): Promise<{ text: string; stderrOutput: string; code: number }> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(opts.command, opts.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.cwd,
      });
    } catch (err: unknown) {
      if (isENOENT(err)) {
        reject(new Error(opts.notFoundMessage));
        return;
      }
      reject(err);
      return;
    }

    registerProcess(proc);

    let rawText = '';
    let stderrOutput = '';
    const stdoutBuf = createLineBuffer(line => opts.onLine(line));

    proc.on('error', (err: NodeJS.ErrnoException) => {
      unregisterProcess(proc);
      if (isENOENT(err)) {
        reject(new Error(opts.notFoundMessage));
      } else {
        reject(err);
      }
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      rawText += str;
      stdoutBuf.push(str);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrOutput += text;
      opts.onStderr?.(text);
    });

    proc.on('close', (code) => {
      unregisterProcess(proc);

      stdoutBuf.flush();

      if (code === 127) {
        reject(new Error(opts.notFoundMessage));
        return;
      }

      if (code !== 0 && !rawText) {
        const detail = stderrOutput.trim();
        reject(new Error(
          `${opts.command} exited with code ${code}${detail ? `: ${detail}` : ''}`,
        ));
        return;
      }

      resolve({ text: rawText, stderrOutput, code: code ?? 0 });
    });

    if (opts.stdin != null) {
      proc.stdin.write(opts.stdin);
    }
    proc.stdin.end();
  });
}

interface ParsedLine {
  text?: string;
  usage?: PlannerTokenUsage;
}

interface SpawnAndCollectOptions {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  notFoundMessage: string;
  parseLine: (line: string) => ParsedLine;
  onOutput: (text: string) => void;
  onStderr?: (chunk: string) => void;
}

export async function spawnAndCollect(opts: SpawnAndCollectOptions): Promise<{ text: string; usage: PlannerTokenUsage | null }> {
  let collectedText = '';
  let usage: PlannerTokenUsage | null = null;

  await spawnWithStdin({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    stdin: opts.stdin,
    notFoundMessage: opts.notFoundMessage,
    onStderr: opts.onStderr,
    onLine(line) {
      const parsed = opts.parseLine(line);
      if (parsed.text) {
        collectedText += parsed.text;
        opts.onOutput(parsed.text);
      }
      if (parsed.usage) {
        usage = accumulateUsage(usage, parsed.usage);
      }
    },
  });

  return { text: collectedText, usage };
}
