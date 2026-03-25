import type { Config, Task, ProjectContext } from '../types.js';
import { buildResearchPrompt, buildSpecPrompt, buildPlanPrompt, buildTasksPrompt } from '../spec/templates.js';
import { parseTasks } from '../spec/parser.js';
import { spawnWithStreaming } from '../utils/process.js';
import { writeSpecFile } from '../utils/fs.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseStreamLine } from './claude-stream.js';

interface PlannerCallbacks {
  onOutput: (text: string) => void;
  onPhase: (phase: string) => void;
}

interface PlanResult {
  spec: string;
  plan: string;
  tasks: Task[];
  usage: { inputTokens: number; outputTokens: number } | null;
}

interface StreamResult {
  text: string;
  sessionId: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
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
      // malformed package.json, skip
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

async function spawnClaude(
  prompt: string,
  projectDir: string,
  sessionId: string | null,
  onOutput: (text: string) => void,
): Promise<StreamResult> {
  const args = ['-p', prompt, '--output-format', 'stream-json'];
  if (sessionId) {
    args.push('--session-id', sessionId);
  }

  let collectedText = '';
  let collectedSessionId = sessionId;
  let stderrOutput = '';
  let usage: { inputTokens: number; outputTokens: number } | null = null;

  let result: { code: number; killed: boolean };
  try {
    result = await spawnWithStreaming(
      'claude',
      args,
      (line) => {
        const parsed = parseStreamLine(line);

        if (parsed.sessionId) {
          collectedSessionId = parsed.sessionId;
        }

        if (parsed.text) {
          collectedText += parsed.text;
          onOutput(parsed.text);
        }

        if (parsed.isResult && parsed.text) {
          collectedText = parsed.text;
        }

        if (parsed.usage) {
          usage = parsed.usage;
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
        'Claude Code CLI not found. Install it from https://claude.ai/code',
      );
    }
    throw err;
  }

  if (result.code === 127) {
    throw new Error(
      'Claude Code CLI not found. Install it from https://claude.ai/code',
    );
  }

  if (result.code !== 0 && !collectedText) {
    const detail = stderrOutput.trim();
    throw new Error(
      `Claude CLI exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
    );
  }

  return { text: collectedText, sessionId: collectedSessionId, usage };
}

export async function planFeature(
  feature: string,
  projectDir: string,
  config: Config,
  callbacks: PlannerCallbacks,
): Promise<PlanResult> {
  const projectContext = buildProjectContext(projectDir);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  function accumulateUsage(streamResult: StreamResult) {
    if (streamResult.usage) {
      totalInputTokens += streamResult.usage.inputTokens;
      totalOutputTokens += streamResult.usage.outputTokens;
    }
  }

  // Phase 1: Research
  callbacks.onPhase('researching');
  const researchPrompt = buildResearchPrompt(feature, projectContext);
  let research: StreamResult;
  try {
    research = await spawnClaude(researchPrompt, projectDir, null, callbacks.onOutput);
  } catch (err) {
    throw new Error(`Research phase failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  accumulateUsage(research);

  writeSpecFile(projectDir, 'research.md', research.text);

  // Phase 2: Specification
  callbacks.onPhase('specifying');
  const specPrompt = buildSpecPrompt(feature, research.text);
  let specResult: StreamResult;
  try {
    specResult = await spawnClaude(specPrompt, projectDir, research.sessionId, callbacks.onOutput);
  } catch (err) {
    throw new Error(`Specification phase failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  accumulateUsage(specResult);
  const spec = specResult.text;

  writeSpecFile(projectDir, 'spec.md', spec);

  // Phase 3: Plan
  callbacks.onPhase('planning');
  const planPrompt = buildPlanPrompt(spec, projectContext);
  let planResult: StreamResult;
  try {
    planResult = await spawnClaude(planPrompt, projectDir, specResult.sessionId, callbacks.onOutput);
  } catch (err) {
    throw new Error(`Planning phase failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  accumulateUsage(planResult);
  const plan = planResult.text;

  writeSpecFile(projectDir, 'plan.md', plan);

  // Phase 4: Tasks
  callbacks.onPhase('generating-tasks');
  const tasksPrompt = buildTasksPrompt(spec, plan);
  let tasksResult: StreamResult;
  try {
    tasksResult = await spawnClaude(tasksPrompt, projectDir, planResult.sessionId, callbacks.onOutput);
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
}
