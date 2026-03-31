import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Task, OutputFormat } from '../../types.js';
import type { PlannerBackend, PlannerCallbacks, PlanResult, EscalationResult, RegenerateResult } from './types.js';
import type { PricingInfo } from '../pricing.js';
import { buildResearchPrompt, buildSpecPrompt, buildPlanPrompt, buildTasksPrompt, buildHintPrompt, buildEscalationPrompt } from '../spec/templates.js';
import { parseTasks } from '../spec/parser.js';
import { extractCode } from '../extractor.js';
import { writeSpecFile } from '../../utils/fs.js';
import { activeProcesses } from '../../utils/process.js';
import { parseStreamLine } from '../claude-stream.js';

const LOCAL_PRICING: PricingInfo = { inputPer1M: 0, outputPer1M: 0, isLocal: false, name: 'Shell planner' };

interface ShellResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

function parseTextLine(line: string): { text: string | null; usage: { inputTokens: number; outputTokens: number } | null } {
  if (!line.trim()) return { text: null, usage: null };

  const tokenMatch = line.match(/Tokens:\s*([\d.]+k?)\s*sent,\s*([\d.]+k?)\s*received/i);
  if (tokenMatch) {
    const parseK = (v: string) => {
      const n = parseFloat(v);
      return v.toLowerCase().endsWith('k') ? Math.round(n * 1000) : Math.round(n);
    };
    return { text: null, usage: { inputTokens: parseK(tokenMatch[1]), outputTokens: parseK(tokenMatch[2]) } };
  }

  return { text: line + '\n', usage: null };
}

function parseJsonlLine(line: string): { text: string | null; usage: { inputTokens: number; outputTokens: number } | null } {
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
        usage: { inputTokens: event.usage.input_tokens ?? 0, outputTokens: event.usage.output_tokens ?? 0 },
      };
    }

    if (event.text) return { text: event.text, usage: null };
    if (event.content) return { text: typeof event.content === 'string' ? event.content : JSON.stringify(event.content), usage: null };

    return { text: null, usage: null };
  } catch {
    return { text: null, usage: null };
  }
}

function getLineParser(format: OutputFormat): (line: string) => { text: string | null; usage: { inputTokens: number; outputTokens: number } | null } {
  switch (format) {
    case 'stream-json': return (line) => {
      const r = parseStreamLine(line);
      return { text: r.isResult ? r.text : r.text, usage: r.usage };
    };
    case 'jsonl': return parseJsonlLine;
    case 'text': return parseTextLine;
  }
}

function spawnShellCommand(
  command: string,
  args: string[],
  prompt: string,
  projectDir: string,
  format: OutputFormat,
  onOutput: (text: string) => void,
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: projectDir,
      });
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Shell planner command not found: ${command}`));
        return;
      }
      reject(err);
      return;
    }

    activeProcesses.add(proc);

    let collectedText = '';
    let stdoutBuffer = '';
    let stderrOutput = '';
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    const parseLine = getLineParser(format);

    proc.on('error', (err: NodeJS.ErrnoException) => {
      activeProcesses.delete(proc);
      if (err.code === 'ENOENT') {
        reject(new Error(`Shell planner command not found: ${command}`));
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
          onOutput(parsed.text);
        }
        if (parsed.usage) {
          if (usage) {
            usage.inputTokens += parsed.usage.inputTokens;
            usage.outputTokens += parsed.usage.outputTokens;
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
          onOutput(parsed.text);
        }
        if (parsed.usage) {
          if (usage) {
            usage.inputTokens += parsed.usage.inputTokens;
            usage.outputTokens += parsed.usage.outputTokens;
          } else {
            usage = { ...parsed.usage };
          }
        }
      }

      if (code === 127) {
        reject(new Error(`Shell planner command not found: ${command}`));
        return;
      }

      if (code !== 0 && !collectedText) {
        const detail = stderrOutput.trim();
        reject(new Error(`Shell planner exited with code ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }

      resolve({ text: collectedText, usage });
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function buildProjectContext(projectDir: string): string {
  const parts: string[] = [];

  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      parts.push(`## Package: ${pkg.name ?? 'unknown'}`);
      if (pkg.description) parts.push(pkg.description);
      if (pkg.scripts) {
        parts.push('\n### Scripts');
        for (const [name, cmd] of Object.entries(pkg.scripts)) {
          parts.push(`- \`${name}\`: \`${cmd}\``);
        }
      }
    } catch {
      // skip
    }
  }

  const srcDir = join(projectDir, 'src');
  if (existsSync(srcDir)) {
    parts.push('\n## Source Files');
    parts.push(listDir(srcDir, projectDir, 0));
  }

  return parts.join('\n');
}

function listDir(dir: string, root: string, depth: number): string {
  const entries = readdirSync(dir, { withFileTypes: true });
  const lines: string[] = [];
  const indent = '  '.repeat(depth);

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;

    const fullPath = join(dir, entry.name);
    const relPath = fullPath.slice(root.length + 1);

    if (entry.isDirectory()) {
      lines.push(`${indent}${relPath}/`);
      lines.push(listDir(fullPath, root, depth + 1));
    } else {
      lines.push(`${indent}${relPath}`);
    }
  }

  return lines.join('\n');
}

export function createShellPlanner(config: Config): PlannerBackend {
  const command = config.planner.command!;
  const baseArgs = config.planner.args ?? [];
  const format: OutputFormat = config.planner.outputFormat ?? 'text';

  return {
    name: `shell:${command}`,

    async plan(
      feature: string,
      projectDir: string,
      _config: Config,
      callbacks: PlannerCallbacks,
    ): Promise<PlanResult> {
      const projectContext = buildProjectContext(projectDir);
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      function accumulateUsage(result: ShellResult) {
        if (result.usage) {
          totalInputTokens += result.usage.inputTokens;
          totalOutputTokens += result.usage.outputTokens;
        }
      }

      callbacks.onPhase('researching');
      const researchPrompt = buildResearchPrompt(feature, projectContext);
      const research = await spawnShellCommand(command, baseArgs, researchPrompt, projectDir, format, callbacks.onOutput);
      accumulateUsage(research);
      writeSpecFile(projectDir, 'research.md', research.text);

      callbacks.onPhase('specifying');
      const specPrompt = buildSpecPrompt(feature, research.text);
      const specResult = await spawnShellCommand(command, baseArgs, specPrompt, projectDir, format, callbacks.onOutput);
      accumulateUsage(specResult);
      const spec = specResult.text;
      writeSpecFile(projectDir, 'spec.md', spec);

      callbacks.onPhase('planning');
      const planPrompt = buildPlanPrompt(spec, projectContext);
      const planResult = await spawnShellCommand(command, baseArgs, planPrompt, projectDir, format, callbacks.onOutput);
      accumulateUsage(planResult);
      const plan = planResult.text;
      writeSpecFile(projectDir, 'plan.md', plan);

      callbacks.onPhase('generating-tasks');
      const tasksPrompt = buildTasksPrompt(spec, plan);
      const tasksResult = await spawnShellCommand(command, baseArgs, tasksPrompt, projectDir, format, callbacks.onOutput);
      accumulateUsage(tasksResult);
      const tasksMarkdown = tasksResult.text;
      writeSpecFile(projectDir, 'tasks.md', tasksMarkdown);

      const tasks = parseTasks(tasksMarkdown);

      const totalUsage = (totalInputTokens > 0 || totalOutputTokens > 0)
        ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
        : null;

      return { spec, plan, tasks, usage: totalUsage };
    },

    async regenerate(
      prompt: string,
      artifactType: 'spec' | 'plan',
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<RegenerateResult> {
      const result = await spawnShellCommand(command, baseArgs, prompt, projectDir, format, callbacks.onOutput);
      const filename = artifactType === 'spec' ? 'spec.md' : 'plan.md';
      writeSpecFile(projectDir, filename, result.text);
      return { text: result.text, usage: result.usage };
    },

    async escalateHint(
      task: Task,
      error: string,
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<EscalationResult> {
      const prompt = buildHintPrompt(task, error);
      try {
        const result = await spawnShellCommand(command, baseArgs, prompt, projectDir, format, callbacks.onOutput);
        return { success: true, output: result.text, code: null, usage: result.usage };
      } catch (err) {
        return { success: false, output: err instanceof Error ? err.message : String(err), code: null, usage: null };
      }
    },

    async escalateFull(
      task: Task,
      error: string,
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<EscalationResult> {
      const lastAttempt = task.currentCode ?? '';
      const prompt = buildEscalationPrompt(task, lastAttempt, error);
      try {
        const result = await spawnShellCommand(command, baseArgs, prompt, projectDir, format, callbacks.onOutput);
        const extracted = extractCode(result.text);
        const code = 'code' in extracted ? extracted.code : null;
        return { success: code !== null, output: result.text, code, usage: result.usage };
      } catch (err) {
        return { success: false, output: err instanceof Error ? err.message : String(err), code: null, usage: null };
      }
    },

    async isAvailable(): Promise<boolean> {
      try {
        const proc = spawn(command, ['--version'], { stdio: 'ignore' });
        return new Promise((resolve) => {
          proc.on('error', () => resolve(false));
          proc.on('close', (code) => resolve(code === 0));
        });
      } catch {
        return false;
      }
    },

    async getVersion(): Promise<string | null> {
      return null;
    },

    getPricing(): PricingInfo {
      return LOCAL_PRICING;
    },
  };
}
