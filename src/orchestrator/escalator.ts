import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import type { Task, Config, ProjectContext } from '../types.js';
import { buildHintPrompt, buildEscalationPrompt } from '../spec/templates.js';
import { extractCode } from './extractor.js';

function parseStreamLine(line: string): string | null {
  if (!line.trim()) return null;

  try {
    const event = JSON.parse(line);

    if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
      return event.content_block.text ?? null;
    }

    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return event.delta.text ?? null;
    }
  } catch {
    // non-JSON line, ignore
  }

  return null;
}

function spawnClaude(
  prompt: string,
  onOutput: (text: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('claude', ['-p', '--output-format', 'stream-json'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        reject(new Error('Claude Code CLI not found. Install it from https://claude.ai/code'));
        return;
      }
      reject(err);
      return;
    }

    let fullResponse = '';
    let stdoutBuffer = '';
    let stderrOutput = '';

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error('Claude Code CLI not found. Install it from https://claude.ai/code'));
      } else {
        reject(err);
      }
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop()!;
      for (const line of lines) {
        const text = parseStreamLine(line);
        if (text) {
          fullResponse += text;
          onOutput(text);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    proc.on('close', (code) => {
      if (stdoutBuffer) {
        const text = parseStreamLine(stdoutBuffer);
        if (text) {
          fullResponse += text;
          onOutput(text);
        }
      }

      if (code === 127) {
        reject(new Error('Claude Code CLI not found. Install it from https://claude.ai/code'));
        return;
      }

      if (code !== 0 && !fullResponse) {
        const detail = stderrOutput.trim();
        reject(new Error(`Claude CLI exited with code ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }

      resolve(fullResponse);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export async function escalateTask(
  task: Task,
  error: string,
  projectDir: string,
  _config: Config,
  _context: ProjectContext,
  callbacks: { onOutput: (text: string) => void },
  tier: 1 | 2 = 1,
): Promise<{ success: boolean; output: string; tier: 1 | 2 }> {
  if (tier === 1) {
    const hintPrompt = buildHintPrompt(task, error);
    const hints = await spawnClaude(hintPrompt, callbacks.onOutput);
    return { success: false, output: hints, tier: 1 };
  }

  const escalationPrompt = buildEscalationPrompt(task, task.currentCode ?? '', error);
  const fullResponse = await spawnClaude(escalationPrompt, callbacks.onOutput);

  const extractResult = extractCode(fullResponse);

  if ('error' in extractResult) {
    return { success: false, output: fullResponse, tier: 2 };
  }

  const filePath = join(projectDir, task.file);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, extractResult.code, 'utf-8');

  return { success: true, output: fullResponse, tier: 2 };
}

export async function escalateTaskFull(
  task: Task,
  error: string,
  projectDir: string,
  config: Config,
  context: ProjectContext,
  callbacks: { onOutput: (text: string) => void },
): Promise<{ success: boolean; output: string; tier: 2 }> {
  const result = await escalateTask(task, error, projectDir, config, context, callbacks, 2);
  return { ...result, tier: 2 };
}
