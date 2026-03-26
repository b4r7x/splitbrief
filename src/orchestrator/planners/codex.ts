import type { Config, Task } from '../../types.js';
import type { PlannerBackend, PlannerCallbacks, PlanResult, EscalationResult, RegenerateResult } from './types.js';
import type { PricingInfo } from '../pricing.js';
import { getPlannerPricing } from '../pricing.js';
import { buildResearchPrompt, buildSpecPrompt, buildPlanPrompt, buildTasksPrompt, buildHintPrompt, buildEscalationPrompt } from '../../spec/templates.js';
import { parseTasks } from '../../spec/parser.js';
import { extractCode } from '../extractor.js';
import { writeSpecFile } from '../../utils/fs.js';
import { spawnWithStreaming, runCommand } from '../../utils/process.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface CodexStreamResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

function parseCodexLine(line: string): {
  text: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
} {
  if (!line.trim()) return { text: null, usage: null };

  try {
    const event = JSON.parse(line);

    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      const content = event.item.content;
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            texts.push(block.text);
          } else if (block.type === 'output_text' && block.text) {
            texts.push(block.text);
          }
        }
        if (texts.length > 0) return { text: texts.join(''), usage: null };
      }
      if (typeof event.item.text === 'string') {
        return { text: event.item.text, usage: null };
      }
    }

    if (event.type === 'turn.completed' && event.usage) {
      return {
        text: null,
        usage: {
          inputTokens: event.usage.input_tokens ?? 0,
          outputTokens: event.usage.output_tokens ?? 0,
        },
      };
    }

    return { text: null, usage: null };
  } catch {
    return { text: null, usage: null };
  }
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

async function spawnCodex(
  prompt: string,
  projectDir: string,
  onOutput: (text: string) => void,
): Promise<CodexStreamResult> {
  const args = ['exec', '--json', '--full-auto', '--cd', projectDir, prompt];

  let collectedText = '';
  let stderrOutput = '';
  let usage: { inputTokens: number; outputTokens: number } | null = null;

  let result: { code: number; killed: boolean };
  try {
    result = await spawnWithStreaming(
      'codex',
      args,
      (line) => {
        const parsed = parseCodexLine(line);

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
      },
      (line) => {
        stderrOutput += line + '\n';
      },
      { cwd: projectDir },
    );
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'Codex CLI not found. Install it with: npm install -g @openai/codex',
      );
    }
    throw err;
  }

  if (result.code === 127) {
    throw new Error(
      'Codex CLI not found. Install it with: npm install -g @openai/codex',
    );
  }

  if (result.code !== 0 && !collectedText) {
    const detail = stderrOutput.trim();
    throw new Error(
      `Codex CLI exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
    );
  }

  return { text: collectedText, usage };
}

export function createCodexPlanner(): PlannerBackend {
  return {
    name: 'codex',

    async plan(
      feature: string,
      projectDir: string,
      _config: Config,
      callbacks: PlannerCallbacks,
    ): Promise<PlanResult> {
      const projectContext = buildProjectContext(projectDir);
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      function accumulateUsage(result: CodexStreamResult) {
        if (result.usage) {
          totalInputTokens += result.usage.inputTokens;
          totalOutputTokens += result.usage.outputTokens;
        }
      }

      callbacks.onPhase('researching');
      const researchPrompt = buildResearchPrompt(feature, projectContext);
      let research: CodexStreamResult;
      try {
        research = await spawnCodex(researchPrompt, projectDir, callbacks.onOutput);
      } catch (err) {
        throw new Error(`Research phase failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      accumulateUsage(research);
      writeSpecFile(projectDir, 'research.md', research.text);

      callbacks.onPhase('specifying');
      const specPrompt = buildSpecPrompt(feature, research.text);
      let specResult: CodexStreamResult;
      try {
        specResult = await spawnCodex(specPrompt, projectDir, callbacks.onOutput);
      } catch (err) {
        throw new Error(`Specification phase failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      accumulateUsage(specResult);
      const spec = specResult.text;
      writeSpecFile(projectDir, 'spec.md', spec);

      callbacks.onPhase('planning');
      const planPrompt = buildPlanPrompt(spec, projectContext);
      let planResult: CodexStreamResult;
      try {
        planResult = await spawnCodex(planPrompt, projectDir, callbacks.onOutput);
      } catch (err) {
        throw new Error(`Planning phase failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      accumulateUsage(planResult);
      const plan = planResult.text;
      writeSpecFile(projectDir, 'plan.md', plan);

      callbacks.onPhase('generating-tasks');
      const tasksPrompt = buildTasksPrompt(spec, plan);
      let tasksResult: CodexStreamResult;
      try {
        tasksResult = await spawnCodex(tasksPrompt, projectDir, callbacks.onOutput);
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
      const result = await spawnCodex(prompt, projectDir, callbacks.onOutput);
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
      let result: CodexStreamResult;
      try {
        result = await spawnCodex(prompt, projectDir, callbacks.onOutput);
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
      const lastAttempt = task.currentCode ?? '';
      const prompt = buildEscalationPrompt(task, lastAttempt, error);
      let result: CodexStreamResult;
      try {
        result = await spawnCodex(prompt, projectDir, callbacks.onOutput);
      } catch (err) {
        return {
          success: false,
          output: err instanceof Error ? err.message : String(err),
          code: null,
          usage: null,
        };
      }

      const extracted = extractCode(result.text);
      if ('error' in extracted) {
        return {
          success: false,
          output: result.text,
          code: null,
          usage: result.usage,
        };
      }

      return {
        success: true,
        output: result.text,
        code: extracted.code,
        usage: result.usage,
      };
    },

    async isAvailable(): Promise<boolean> {
      try {
        const { code } = await runCommand('codex', ['--version']);
        return code === 0;
      } catch {
        return false;
      }
    },

    async getVersion(): Promise<string | null> {
      try {
        const { runCommand } = await import('../../utils/process.js');
        const { parseVersion } = await import('../../utils/version.js');
        const { stdout, code } = await runCommand('codex', ['--version']);
        if (code !== 0) return null;
        const ver = parseVersion(stdout);
        return ver ? ver.join('.') : null;
      } catch {
        return null;
      }
    },

    getPricing(): PricingInfo {
      return getPlannerPricing('codex');
    },
  };
}
