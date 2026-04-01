import type { Config, Task } from '../../types.js';
import type { PlannerBackend, PlannerCallbacks, PlanResult, EscalationResult, RegenerateResult } from './types.js';
import type { PricingInfo } from '../pricing.js';
import { getPlannerPricing } from '../pricing.js';
import { parseTasks } from '../spec/parser.js';
import { buildResearchPrompt, buildSpecPrompt, buildPlanPrompt, buildTasksPrompt, buildHintPrompt, buildEscalationPrompt } from '../spec/templates.js';
import { extractCode } from '../extractor.js';
import { spawnWithStreaming, runCommand } from '../../utils/process.js';
import { writeSpecFile } from '../../utils/fs.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
      // malformed package.json
    }
  }

  const readmePath = join(projectDir, 'README.md');
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf-8');
    const first50 = readme.split('\n').slice(0, 50).join('\n');
    parts.push('\n## README (first 50 lines)');
    parts.push(first50);
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

function parseKTokens(value: string): number {
  const num = parseFloat(value);
  if (value.toLowerCase().endsWith('k')) return Math.round(num * 1000);
  return Math.round(num);
}

function parseTokenUsage(output: string): { inputTokens: number; outputTokens: number } | null {
  const match = output.match(/Tokens:\s*([\d.]+k?)\s*sent,\s*([\d.]+k?)\s*received/i);
  if (!match) return null;

  return {
    inputTokens: parseKTokens(match[1]),
    outputTokens: parseKTokens(match[2]),
  };
}

async function spawnAider(
  args: string[],
  projectDir: string,
  onOutput: (text: string) => void,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } | null }> {
  let collectedText = '';
  let stderrOutput = '';

  let result: { code: number; killed: boolean };
  try {
    result = await spawnWithStreaming(
      'aider',
      args,
      (line) => {
        collectedText += line + '\n';
        onOutput(line + '\n');
      },
      (line) => {
        stderrOutput += line + '\n';
      },
      { cwd: projectDir },
    );
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Aider not found. Install it from https://aider.chat');
    }
    throw err;
  }

  if (result.code === 127) {
    throw new Error('Aider not found. Install it from https://aider.chat');
  }

  if (result.code !== 0 && !collectedText.trim()) {
    const detail = stderrOutput.trim();
    throw new Error(
      `Aider exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
    );
  }

  const usage = parseTokenUsage(collectedText + stderrOutput);
  return { text: collectedText.trim(), usage };
}

function aiderAskArgs(model: string | undefined, prompt: string, readDirs?: string[]): string[] {
  const args = ['--chat-mode', 'ask', '--yes-always', '--no-stream', '--no-pretty', '--message', prompt];
  if (model) {
    args.unshift('--model', model);
  }
  if (readDirs) {
    for (const dir of readDirs) {
      args.push('--read', dir);
    }
  }
  return args;
}

export function createAiderPlanner(): PlannerBackend {
  return {
    name: 'aider',

    async plan(
      feature: string,
      projectDir: string,
      config: Config,
      callbacks: PlannerCallbacks,
      skillsContext?: string,
    ): Promise<PlanResult> {
      const projectContext = buildProjectContext(projectDir);
      const model = (config.planner as { model?: string }).model;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      function accumulateUsage(usage: { inputTokens: number; outputTokens: number } | null) {
        if (usage) {
          totalInputTokens += usage.inputTokens;
          totalOutputTokens += usage.outputTokens;
        }
      }

      // Phase 1: Research
      callbacks.onPhase('researching');
      const researchPrompt = buildResearchPrompt(feature, projectContext, skillsContext);
      const research = await spawnAider(
        aiderAskArgs(model, researchPrompt, ['src/']),
        projectDir,
        callbacks.onOutput,
      );
      accumulateUsage(research.usage);
      writeSpecFile(projectDir, 'research.md', research.text);

      // Phase 2: Specification
      callbacks.onPhase('specifying');
      const specPrompt = buildSpecPrompt(feature, research.text);
      const specResult = await spawnAider(
        aiderAskArgs(model, specPrompt, ['src/']),
        projectDir,
        callbacks.onOutput,
      );
      accumulateUsage(specResult.usage);
      const spec = specResult.text;
      writeSpecFile(projectDir, 'spec.md', spec);

      // Phase 3: Plan
      callbacks.onPhase('planning');
      const planPrompt = buildPlanPrompt(spec, projectContext, skillsContext);
      const planResult = await spawnAider(
        aiderAskArgs(model, planPrompt, ['src/']),
        projectDir,
        callbacks.onOutput,
      );
      accumulateUsage(planResult.usage);
      const plan = planResult.text;
      writeSpecFile(projectDir, 'plan.md', plan);

      // Phase 4: Tasks
      callbacks.onPhase('generating-tasks');
      const tasksPrompt = buildTasksPrompt(spec, plan);
      const tasksResult = await spawnAider(
        aiderAskArgs(model, tasksPrompt, ['src/']),
        projectDir,
        callbacks.onOutput,
      );
      accumulateUsage(tasksResult.usage);
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
      const result = await spawnAider(
        aiderAskArgs(undefined, prompt, ['src/']),
        projectDir,
        callbacks.onOutput,
      );
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
      const args = ['--chat-mode', 'ask', '--yes-always', '--no-stream', '--no-pretty', '--message', prompt];

      try {
        const result = await spawnAider(args, projectDir, callbacks.onOutput);
        return {
          success: true,
          output: result.text,
          code: null,
          usage: result.usage,
        };
      } catch (err) {
        return {
          success: false,
          output: err instanceof Error ? err.message : String(err),
          code: null,
          usage: null,
        };
      }
    },

    async escalateFull(
      task: Task,
      error: string,
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<EscalationResult> {
      const lastAttempt = '';
      const prompt = buildEscalationPrompt(task, lastAttempt, error);
      const args = [
        '--yes-always', '--no-stream', '--no-pretty', '--no-auto-commits',
        '--message', prompt,
        task.file,
      ];

      try {
        const result = await spawnAider(args, projectDir, callbacks.onOutput);
        const extracted = extractCode(result.text);
        const code = 'code' in extracted ? extracted.code : null;

        return {
          success: code !== null,
          output: result.text,
          code,
          usage: result.usage,
        };
      } catch (err) {
        return {
          success: false,
          output: err instanceof Error ? err.message : String(err),
          code: null,
          usage: null,
        };
      }
    },

    async isAvailable(): Promise<boolean> {
      try {
        const result = await runCommand('aider', ['--version']);
        return result.code === 0;
      } catch {
        return false;
      }
    },

    async getVersion(): Promise<string | null> {
      try {
        const { runCommand } = await import('../../utils/process.js');
        const { parseVersion } = await import('../../utils/version.js');
        const { stdout, code } = await runCommand('aider', ['--version']);
        if (code !== 0) return null;
        const ver = parseVersion(stdout);
        return ver ? ver.join('.') : null;
      } catch {
        return null;
      }
    },

    getPricing(): PricingInfo {
      return getPlannerPricing('aider');
    },
  };
}
