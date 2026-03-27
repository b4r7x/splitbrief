import type { Config, Task } from '../../types.js';
import type { PlannerBackend, PlannerCallbacks, PlanResult, EscalationResult, RegenerateResult } from './types.js';
import { getPlannerPricing } from '../pricing.js';
import { parseTasks } from '../../spec/parser.js';
import { extractCode } from '../extractor.js';
import { writeSpecFile } from '../../utils/fs.js';
import {
  buildResearchPrompt,
  buildSpecPrompt,
  buildPlanPrompt,
  buildTasksPrompt,
  buildHintPrompt,
  buildEscalationPrompt,
} from '../../spec/templates.js';
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

async function loadSdk(): Promise<{ query: (...args: any[]) => any }> {
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    throw new Error(
      'Agent SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
    );
  }
}

function extractTextFromMessage(message: any): string {
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');
  }
  return '';
}

interface QueryResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  costUsd: number | null;
}

async function runQuery(
  prompt: string,
  projectDir: string,
  model: string,
  allowedTools: string[],
  permissionMode: string,
  onOutput: (text: string) => void,
): Promise<QueryResult> {
  const { query } = await loadSdk();

  let collectedText = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let costUsd: number | null = null;

  for await (const message of query({
    prompt,
    options: {
      allowedTools,
      permissionMode,
      model,
      cwd: projectDir,
    },
  })) {
    if (message.type === 'assistant') {
      const text = extractTextFromMessage(message);
      if (text) {
        collectedText += text;
        onOutput(text);
      }
    }

    if (message.type === 'result') {
      if (message.total_cost_usd != null) {
        costUsd = message.total_cost_usd;
      }
      if (message.usage) {
        totalInputTokens += message.usage.input_tokens ?? 0;
        totalOutputTokens += message.usage.output_tokens ?? 0;
      }
      const resultText = extractTextFromMessage(message);
      if (resultText) {
        collectedText = resultText;
      }
    }
  }

  const usage = (totalInputTokens > 0 || totalOutputTokens > 0)
    ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
    : null;

  return { text: collectedText, usage, costUsd };
}

export function createAgentSdkPlanner(): PlannerBackend {
  const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
  const WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Write'];

  return {
    name: 'agent-sdk',

    async plan(
      feature: string,
      projectDir: string,
      config: Config,
      callbacks: PlannerCallbacks,
    ): Promise<PlanResult> {
      const model = (config.planner as any).model || 'claude-sonnet-4-6';
      const projectContext = buildProjectContext(projectDir);
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      function accumulate(result: QueryResult) {
        if (result.usage) {
          totalInputTokens += result.usage.inputTokens;
          totalOutputTokens += result.usage.outputTokens;
        }
      }

      callbacks.onPhase('researching');
      const researchPrompt = buildResearchPrompt(feature, projectContext);
      const research = await runQuery(
        researchPrompt, projectDir, model, WRITE_TOOLS, 'acceptEdits', callbacks.onOutput,
      );
      accumulate(research);
      writeSpecFile(projectDir, 'research.md', research.text);

      callbacks.onPhase('specifying');
      const specPrompt = buildSpecPrompt(feature, research.text);
      const specResult = await runQuery(
        specPrompt, projectDir, model, WRITE_TOOLS, 'acceptEdits', callbacks.onOutput,
      );
      accumulate(specResult);
      const spec = specResult.text;
      writeSpecFile(projectDir, 'spec.md', spec);

      callbacks.onPhase('planning');
      const planPrompt = buildPlanPrompt(spec, projectContext);
      const planResult = await runQuery(
        planPrompt, projectDir, model, WRITE_TOOLS, 'acceptEdits', callbacks.onOutput,
      );
      accumulate(planResult);
      const plan = planResult.text;
      writeSpecFile(projectDir, 'plan.md', plan);

      callbacks.onPhase('generating-tasks');
      const tasksPrompt = buildTasksPrompt(spec, plan);
      const tasksResult = await runQuery(
        tasksPrompt, projectDir, model, WRITE_TOOLS, 'acceptEdits', callbacks.onOutput,
      );
      accumulate(tasksResult);
      const tasksMarkdown = tasksResult.text;
      writeSpecFile(projectDir, 'tasks.md', tasksMarkdown);

      const tasks = parseTasks(tasksMarkdown);
      const usage = (totalInputTokens > 0 || totalOutputTokens > 0)
        ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
        : null;

      return { spec, plan, tasks, usage };
    },

    async regenerate(
      prompt: string,
      artifactType: 'spec' | 'plan',
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<RegenerateResult> {
      const result = await runQuery(
        prompt, projectDir, 'claude-sonnet-4-6', WRITE_TOOLS, 'acceptEdits', callbacks.onOutput,
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
      try {
        const result = await runQuery(
          prompt, projectDir, 'claude-sonnet-4-6', READ_ONLY_TOOLS, 'acceptEdits', callbacks.onOutput,
        );
        return {
          success: result.text.length > 0,
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
      const prompt = buildEscalationPrompt(task, task.currentCode ?? '', error);
      try {
        const result = await runQuery(
          prompt, projectDir, 'claude-sonnet-4-6', WRITE_TOOLS, 'acceptEdits', callbacks.onOutput,
        );

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
      if (!process.env.ANTHROPIC_API_KEY) return false;
      try {
        await import('@anthropic-ai/claude-agent-sdk');
        return true;
      } catch {
        return false;
      }
    },

    async getVersion(): Promise<string | null> {
      return null;
    },

    getPricing() {
      return getPlannerPricing('agent-sdk');
    },
  };
}
