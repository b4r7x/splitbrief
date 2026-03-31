import type { Task, Config } from '../../types.js';
import type { PlannerBackend, PlannerCallbacks, PlanResult, EscalationResult, RegenerateResult } from './types.js';
import { getPlannerPricing } from '../pricing.js';
import { parseTasks } from '../spec/parser.js';
import {
  buildResearchPrompt,
  buildSpecPrompt,
  buildPlanPrompt,
  buildTasksPrompt,
  buildHintPrompt,
  buildEscalationPrompt,
} from '../spec/templates.js';
import { extractCode } from '../extractor.js';
import { writeSpecFile } from '../../utils/fs.js';
import { spawnWithStreaming, runCommand, activeProcesses } from '../../utils/process.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface StepFinishUsage {
  tokens: { input: number; output: number };
  cost: number;
}

interface StreamResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

function parseNdjsonLine(line: string): { text?: string; usage?: StepFinishUsage } {
  const trimmed = line.trim();
  if (!trimmed) return {};

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }

  if (parsed.type === 'text' && typeof parsed.text === 'string') {
    return { text: parsed.text };
  }

  if (parsed.type === 'step_finish') {
    const usage = parsed.usage as StepFinishUsage | undefined;
    if (usage?.tokens) {
      return { usage };
    }
  }

  return {};
}

async function spawnOpenCode(
  agent: string,
  prompt: string,
  projectDir: string,
  onOutput: (text: string) => void,
): Promise<StreamResult> {
  const args = ['run', '--format', 'json', '--agent', agent, prompt];

  let collectedText = '';
  let stderrOutput = '';
  let totalInput = 0;
  let totalOutput = 0;
  let hasUsage = false;

  let result: { code: number; killed: boolean };
  try {
    result = await spawnWithStreaming(
      'opencode',
      args,
      (line) => {
        const { text, usage } = parseNdjsonLine(line);

        if (text) {
          collectedText += text;
          onOutput(text);
        }

        if (usage) {
          totalInput += usage.tokens.input;
          totalOutput += usage.tokens.output;
          hasUsage = true;
        }
      },
      (line) => {
        stderrOutput += line + '\n';
      },
      { cwd: projectDir },
    );
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('OpenCode CLI not found. Install it from https://github.com/nicholasoxford/opencode');
    }
    throw err;
  }

  if (result.code === 127) {
    throw new Error('OpenCode CLI not found. Install it from https://github.com/nicholasoxford/opencode');
  }

  if (result.code !== 0 && !collectedText) {
    const detail = stderrOutput.trim();
    throw new Error(
      `OpenCode CLI exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
    );
  }

  return {
    text: collectedText,
    usage: hasUsage ? { inputTokens: totalInput, outputTokens: totalOutput } : null,
  };
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

export function createOpenCodePlanner(): PlannerBackend {
  return {
    name: 'opencode',

    async plan(
      feature: string,
      projectDir: string,
      config: Config,
      callbacks: PlannerCallbacks,
    ): Promise<PlanResult> {
      const projectContext = buildProjectContext(projectDir);
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      function accumulateUsage(result: StreamResult) {
        if (result.usage) {
          totalInputTokens += result.usage.inputTokens;
          totalOutputTokens += result.usage.outputTokens;
        }
      }

      callbacks.onPhase('researching');
      const researchPrompt = buildResearchPrompt(feature, projectContext);
      let research: StreamResult;
      try {
        research = await spawnOpenCode('plan', researchPrompt, projectDir, callbacks.onOutput);
      } catch (err) {
        throw new Error(`Research phase failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      accumulateUsage(research);
      writeSpecFile(projectDir, 'research.md', research.text);

      callbacks.onPhase('specifying');
      const specPrompt = buildSpecPrompt(feature, research.text);
      let specResult: StreamResult;
      try {
        specResult = await spawnOpenCode('plan', specPrompt, projectDir, callbacks.onOutput);
      } catch (err) {
        throw new Error(`Specification phase failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      accumulateUsage(specResult);
      const spec = specResult.text;
      writeSpecFile(projectDir, 'spec.md', spec);

      callbacks.onPhase('planning');
      const planPrompt = buildPlanPrompt(spec, projectContext);
      let planResult: StreamResult;
      try {
        planResult = await spawnOpenCode('plan', planPrompt, projectDir, callbacks.onOutput);
      } catch (err) {
        throw new Error(`Planning phase failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      accumulateUsage(planResult);
      const plan = planResult.text;
      writeSpecFile(projectDir, 'plan.md', plan);

      callbacks.onPhase('generating-tasks');
      const tasksPrompt = buildTasksPrompt(spec, plan);
      let tasksResult: StreamResult;
      try {
        tasksResult = await spawnOpenCode('plan', tasksPrompt, projectDir, callbacks.onOutput);
      } catch (err) {
        throw new Error(`Task generation phase failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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
      const result = await spawnOpenCode('plan', prompt, projectDir, callbacks.onOutput);
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
      let result: StreamResult;
      try {
        result = await spawnOpenCode('plan', prompt, projectDir, callbacks.onOutput);
      } catch (err) {
        return {
          success: false,
          output: err instanceof Error ? err.message : String(err),
          code: null,
          usage: null,
        };
      }

      return {
        success: true,
        output: result.text,
        code: null,
        usage: result.usage,
      };
    },

    async escalateFull(
      task: Task,
      error: string,
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<EscalationResult> {
      const lastAttempt = '';
      const prompt = buildEscalationPrompt(task, lastAttempt, error);
      let result: StreamResult;
      try {
        result = await spawnOpenCode('build', prompt, projectDir, callbacks.onOutput);
      } catch (err) {
        return {
          success: false,
          output: err instanceof Error ? err.message : String(err),
          code: null,
          usage: null,
        };
      }

      const extracted = extractCode(result.text);
      const code = 'code' in extracted ? extracted.code : null;

      return {
        success: code !== null,
        output: result.text,
        code,
        usage: result.usage,
      };
    },

    async isAvailable(): Promise<boolean> {
      try {
        const { code } = await runCommand('opencode', ['--version'], { timeout: 5000 });
        return code === 0;
      } catch {
        return false;
      }
    },

    async getVersion(): Promise<string | null> {
      try {
        const { runCommand } = await import('../../utils/process.js');
        const { parseVersion } = await import('../../utils/version.js');
        const { stdout, code } = await runCommand('opencode', ['--version'], { timeout: 5000 });
        if (code !== 0) return null;
        const ver = parseVersion(stdout);
        return ver ? ver.join('.') : null;
      } catch {
        return null;
      }
    },

    getPricing() {
      return getPlannerPricing('opencode');
    },
  };
}
