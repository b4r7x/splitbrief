import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import type { Task, Config, ProjectContext } from '../types.js';
import { buildHintPrompt, buildEscalationPrompt } from '../spec/templates.js';
import { extractCode } from './extractor.js';
import { validateTaskPath } from '../utils/fs.js';
import { parseStreamLine } from './claude-stream.js';
import { activeProcesses } from '../utils/process.js';

function spawnClaude(
  prompt: string,
  projectDir: string,
  onOutput: (text: string) => void,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } | null }> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('claude', ['-p', '--output-format', 'stream-json'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: projectDir,
      });
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('Claude Code CLI not found. Install it from https://claude.ai/code'));
        return;
      }
      reject(err);
      return;
    }

    activeProcesses.add(proc);
    proc.on('close', () => { activeProcesses.delete(proc); });

    let fullResponse = '';
    let stdoutBuffer = '';
    let stderrOutput = '';
    let usage: { inputTokens: number; outputTokens: number } | null = null;

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
        const parsed = parseStreamLine(line);
        if (parsed.isResult && parsed.text) {
          fullResponse = parsed.text;
        } else if (parsed.text) {
          fullResponse += parsed.text;
          onOutput(parsed.text);
        }
        if (parsed.usage) {
          usage = parsed.usage;
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    proc.on('close', (code) => {
      activeProcesses.delete(proc);

      if (stdoutBuffer) {
        const parsed = parseStreamLine(stdoutBuffer);
        if (parsed.isResult && parsed.text) {
          fullResponse = parsed.text;
        } else if (parsed.text) {
          fullResponse += parsed.text;
          onOutput(parsed.text);
        }
        if (parsed.usage) {
          usage = parsed.usage;
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

      resolve({ text: fullResponse, usage });
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
): Promise<{ success: boolean; output: string; tier: 1 | 2; usage: { inputTokens: number; outputTokens: number } | null }> {
  if (tier === 1) {
    const hintPrompt = buildHintPrompt(task, error);
    const result = await spawnClaude(hintPrompt, projectDir, callbacks.onOutput);
    return { success: false, output: result.text, tier: 1, usage: result.usage };
  }

  const escalationPrompt = buildEscalationPrompt(task, task.currentCode ?? '', error);
  const result = await spawnClaude(escalationPrompt, projectDir, callbacks.onOutput);

  const extractResult = extractCode(result.text);

  if ('error' in extractResult) {
    return { success: false, output: result.text, tier: 2, usage: result.usage };
  }

  const filePath = validateTaskPath(projectDir, task.file);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, extractResult.code, 'utf-8');

  return { success: true, output: result.text, tier: 2, usage: result.usage };
}
