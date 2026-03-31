import { spawn } from 'node:child_process';
import type { Task, Config, ProjectContext, OutputFormat } from '../../types.js';
import { formatTaskPrompt, formatRetryPrompt, SYSTEM_PREAMBLE } from '../spec/formatter.js';
import { extractCode } from '../extractor.js';
import { applyCode } from '../implementer.js';
import { activeProcesses } from '../../utils/process.js';

interface ShellImplResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number } | null;
}

function parseTextLine(line: string): { text: string | null; usage: null } {
  if (!line.trim()) return { text: null, usage: null };
  return { text: line + '\n', usage: null };
}

function parseJsonlLine(line: string): { text: string | null; usage: { promptTokens: number; completionTokens: number } | null } {
  if (!line.trim()) return { text: null, usage: null };

  try {
    const event = JSON.parse(line);

    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      const content = event.item.content;
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
          if ((block.type === 'text' || block.type === 'output_text') && block.text) {
            texts.push(block.text);
          }
        }
        if (texts.length > 0) return { text: texts.join(''), usage: null };
      }
      if (typeof event.item.text === 'string') return { text: event.item.text, usage: null };
    }

    if (event.type === 'turn.completed' && event.usage) {
      return {
        text: null,
        usage: {
          promptTokens: event.usage.input_tokens ?? event.usage.prompt_tokens ?? 0,
          completionTokens: event.usage.output_tokens ?? event.usage.completion_tokens ?? 0,
        },
      };
    }

    if (event.text) return { text: event.text, usage: null };
    if (event.content) return { text: typeof event.content === 'string' ? event.content : JSON.stringify(event.content), usage: null };

    return { text: null, usage: null };
  } catch {
    return { text: null, usage: null };
  }
}

function parseStreamJsonLine(line: string): { text: string | null; usage: { promptTokens: number; completionTokens: number } | null } {
  if (!line.trim()) return { text: null, usage: null };

  try {
    const event = JSON.parse(line);

    if (event.type === 'assistant' && event.message?.content) {
      const content = event.message.content;
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) texts.push(block.text);
        }
        if (texts.length > 0) return { text: texts.join(''), usage: null };
      }
    }

    if (event.type === 'result' && event.result) {
      return { text: event.result, usage: null };
    }

    if (event.type === 'usage' || event.usage) {
      const u = event.usage ?? event;
      return {
        text: null,
        usage: {
          promptTokens: u.input_tokens ?? u.prompt_tokens ?? 0,
          completionTokens: u.output_tokens ?? u.completion_tokens ?? 0,
        },
      };
    }

    return { text: null, usage: null };
  } catch {
    return { text: null, usage: null };
  }
}

function getLineParser(format: OutputFormat): (line: string) => { text: string | null; usage: { promptTokens: number; completionTokens: number } | null } {
  switch (format) {
    case 'stream-json': return parseStreamJsonLine;
    case 'jsonl': return parseJsonlLine;
    case 'text': return parseTextLine;
  }
}

function spawnShellImplementer(
  command: string,
  args: string[],
  prompt: string,
  projectDir: string,
  format: OutputFormat,
  onProgress: (text: string) => void,
): Promise<ShellImplResult> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: projectDir,
      });
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Shell implementer command not found: ${command}`));
        return;
      }
      reject(err);
      return;
    }

    activeProcesses.add(proc);

    let collectedText = '';
    let stdoutBuffer = '';
    let stderrOutput = '';
    let usage: { promptTokens: number; completionTokens: number } | null = null;
    const parseLine = getLineParser(format);

    proc.on('error', (err: NodeJS.ErrnoException) => {
      activeProcesses.delete(proc);
      if (err.code === 'ENOENT') {
        reject(new Error(`Shell implementer command not found: ${command}`));
      } else {
        reject(err);
      }
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop()!;
      for (const line of lines) {
        const parsed = parseLine(line);
        if (parsed.text) {
          collectedText += parsed.text;
          onProgress(parsed.text);
        }
        if (parsed.usage) {
          if (usage) {
            usage.promptTokens += parsed.usage.promptTokens;
            usage.completionTokens += parsed.usage.completionTokens;
          } else {
            usage = { ...parsed.usage };
          }
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    proc.on('close', (code) => {
      activeProcesses.delete(proc);

      if (stdoutBuffer) {
        const parsed = parseLine(stdoutBuffer);
        if (parsed.text) {
          collectedText += parsed.text;
          onProgress(parsed.text);
        }
        if (parsed.usage) {
          if (usage) {
            usage.promptTokens += parsed.usage.promptTokens;
            usage.completionTokens += parsed.usage.completionTokens;
          } else {
            usage = { ...parsed.usage };
          }
        }
      }

      if (code === 127) {
        reject(new Error(`Shell implementer command not found: ${command}`));
        return;
      }

      if (code !== 0 && !collectedText) {
        const detail = stderrOutput.trim();
        reject(new Error(`Shell implementer exited with code ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }

      resolve({ text: collectedText, usage });
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export async function implementTaskViaShell(
  task: Task,
  projectDir: string,
  config: Config,
  context: ProjectContext,
  onProgress: (text: string) => void,
): Promise<{ success: boolean; output: string; error?: string; usage?: { promptTokens: number; completionTokens: number } }> {
  const command = config.implementer.command!;
  const args = config.implementer.args ?? [];
  const format: OutputFormat = config.implementer.outputFormat ?? 'text';
  const prompt = SYSTEM_PREAMBLE + '\n\n' + formatTaskPrompt(task, context, config.implementer.contextLength);

  let result: ShellImplResult;
  try {
    result = await spawnShellImplementer(command, args, prompt, projectDir, format, onProgress);
  } catch (err) {
    if (err instanceof Error && err.message.includes('command not found')) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: msg };
  }

  const extractResult = extractCode(result.text);

  if ('error' in extractResult) {
    return { success: false, output: result.text, error: extractResult.error, usage: result.usage ?? undefined };
  }

  const applyResult = applyCode(extractResult.code, task, projectDir);

  if (!applyResult.success) {
    return { success: false, output: result.text, error: applyResult.error, usage: result.usage ?? undefined };
  }

  return { success: true, output: result.text, usage: result.usage ?? undefined };
}

export async function retryTaskViaShell(
  task: Task,
  projectDir: string,
  config: Config,
  context: ProjectContext,
  error: string,
  attempt: number,
  onProgress: (text: string) => void,
): Promise<{ success: boolean; output: string; error?: string; usage?: { promptTokens: number; completionTokens: number } }> {
  const command = config.implementer.command!;
  const args = config.implementer.args ?? [];
  const format: OutputFormat = config.implementer.outputFormat ?? 'text';
  const prompt = SYSTEM_PREAMBLE + '\n\n' + formatRetryPrompt(task, context, error, attempt);

  let result: ShellImplResult;
  try {
    result = await spawnShellImplementer(command, args, prompt, projectDir, format, onProgress);
  } catch (err) {
    if (err instanceof Error && err.message.includes('command not found')) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: msg };
  }

  const extractResult = extractCode(result.text);

  if ('error' in extractResult) {
    return { success: false, output: result.text, error: extractResult.error, usage: result.usage ?? undefined };
  }

  const applyResult = applyCode(extractResult.code, task, projectDir);

  if (!applyResult.success) {
    return { success: false, output: result.text, error: applyResult.error, usage: result.usage ?? undefined };
  }

  return { success: true, output: result.text, usage: result.usage ?? undefined };
}
