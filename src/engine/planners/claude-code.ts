import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Config, Task } from '../../types.js';
import type { PlannerBackend, PlannerCallbacks, PlanResult, EscalationResult, RegenerateResult } from './types.js';
import { buildResearchPrompt, buildSpecPrompt, buildPlanPrompt, buildTasksPrompt, buildHintPrompt, buildEscalationPrompt } from '../spec/templates.js';
import { parseTasks } from '../spec/parser.js';
import { writeSpecFile, validateTaskPath } from '../../utils/fs.js';
import { spawnWithStreaming, activeProcesses } from '../../utils/process.js';
import { parseStreamLine } from '../claude-stream.js';
import { extractCode } from '../extractor.js';
import { getPlannerPricing } from '../pricing.js';
import { createQuestionAccumulator } from '../question-parser.js';
import type { ClarificationQuestion } from '../question-parser.js';

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

async function spawnClaudePlanner(
  prompt: string,
  projectDir: string,
  sessionId: string | null,
  onOutput: (text: string) => void,
  onQuestion?: (questions: ClarificationQuestion[]) => void,
): Promise<StreamResult> {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (sessionId) {
    args.push('--session-id', sessionId);
  }

  let collectedText = '';
  let collectedSessionId = sessionId;
  let stderrOutput = '';
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  const questionAccumulator = createQuestionAccumulator();

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

          if (onQuestion) {
            const newQuestions = questionAccumulator.addChunk(parsed.text);
            if (newQuestions.length > 0) {
              onQuestion(newQuestions);
            }
          }
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

function spawnClaudeEscalator(
  prompt: string,
  projectDir: string,
  onOutput: (text: string) => void,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } | null }> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose'], {
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

export function createClaudeCodePlanner(): PlannerBackend {
  return {
    name: 'claude-code',

    async plan(
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

      callbacks.onPhase('researching');
      const researchPrompt = buildResearchPrompt(feature, projectContext);
      let research: StreamResult;
      try {
        research = await spawnClaudePlanner(researchPrompt, projectDir, null, callbacks.onOutput, callbacks.onQuestion);
      } catch (err) {
        throw new Error(`Research phase failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      accumulateUsage(research);
      writeSpecFile(projectDir, 'research.md', research.text);

      callbacks.onPhase('specifying');
      const specPrompt = buildSpecPrompt(feature, research.text);
      let specResult: StreamResult;
      try {
        specResult = await spawnClaudePlanner(specPrompt, projectDir, research.sessionId, callbacks.onOutput, callbacks.onQuestion);
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
        planResult = await spawnClaudePlanner(planPrompt, projectDir, specResult.sessionId, callbacks.onOutput, callbacks.onQuestion);
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
        tasksResult = await spawnClaudePlanner(tasksPrompt, projectDir, planResult.sessionId, callbacks.onOutput, callbacks.onQuestion);
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
      const result = await spawnClaudeEscalator(prompt, projectDir, callbacks.onOutput);
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
      const hintPrompt = buildHintPrompt(task, error);
      const result = await spawnClaudeEscalator(hintPrompt, projectDir, callbacks.onOutput);
      return { success: false, output: result.text, code: null, usage: result.usage };
    },

    async escalateFull(
      task: Task,
      error: string,
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<EscalationResult> {
      const escalationPrompt = buildEscalationPrompt(task, task.currentCode ?? '', error);
      const result = await spawnClaudeEscalator(escalationPrompt, projectDir, callbacks.onOutput);

      const extractResult = extractCode(result.text);

      if ('error' in extractResult) {
        return { success: false, output: result.text, code: null, usage: result.usage };
      }

      const filePath = validateTaskPath(projectDir, task.file);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, extractResult.code, 'utf-8');

      return { success: true, output: result.text, code: extractResult.code, usage: result.usage };
    },

    async isAvailable(): Promise<boolean> {
      try {
        const result = await spawnWithStreaming(
          'claude',
          ['--version'],
          () => {},
          () => {},
        );
        return result.code === 0;
      } catch {
        return false;
      }
    },

    async getVersion(): Promise<string | null> {
      try {
        const { runCommand } = await import('../../utils/process.js');
        const result = await runCommand('claude', ['--version'], { timeout: 5000 });
        if (result.code !== 0) return null;
        const { parseVersion } = await import('../../utils/version.js');
        const ver = parseVersion(result.stdout);
        return ver ? ver.join('.') : null;
      } catch {
        return null;
      }
    },

    getPricing() {
      return getPlannerPricing('claude-code');
    },
  };
}
