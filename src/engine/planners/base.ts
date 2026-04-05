import type { Task, Config, PlannerTool, PlannerTokenUsage } from '../../types.js';
import type { PlannerBackend, PlannerCallbacks, PlanResult, EscalationResult, RegenerateResult } from './types.js';
import { buildResearchPrompt, buildSpecPrompt, buildPlanPrompt, buildTasksPrompt } from '../spec/planning-prompts.js';
import { buildHintPrompt, buildEscalationPrompt } from '../spec/execution-prompts.js';
import { buildQuickPlanPrompt } from '../spec/planning-prompts.js';
import { parseTasks } from '../spec/parser.js';
import { writeSpecFile } from '../../utils/fs.js';
import { extractCode } from '../extractor.js';
import { getPlannerPricing } from '../pricing.js';
import { runCommand } from '../../utils/process.js';
import { parseVersion } from '../../utils/format.js';
import type { ClarificationQuestion } from '../question-parser.js';
import { buildProjectContextMarkdown } from './context.js';
import { accumulateUsage } from '../output-parsers.js';

// Static check by tool name — called before PlannerBackend is instantiated (see orchestrator/planning.ts)
export function supportsConversational(tool: PlannerTool): boolean {
  return tool === 'claude-code' || tool === 'agent-sdk';
}

export interface InvokeResult {
  text: string;
  usage: PlannerTokenUsage | null;
}

type InvokeFn = (
  prompt: string,
  projectDir: string,
  onOutput: (text: string) => void,
  onQuestion?: (questions: ClarificationQuestion[]) => void,
) => Promise<InvokeResult>;

interface PlannerBaseConfig {
  name: string;
  pricingKey: string;
  conversational?: boolean;
  invokePlan: InvokeFn;
  invokeEscalate: InvokeFn;
  isAvailable: () => Promise<boolean>;
  getVersion: () => Promise<string | null>;
  escalateHintSuccess?: (result: InvokeResult) => boolean;
  escalateFullPostProcess?: (task: Task, result: InvokeResult, extracted: { code: string }, projectDir: string) => EscalationResult;
}

export function createGetVersion(command: string, versionArgs?: string[]): () => Promise<string | null> {
  return async () => {
    try {
      const { stdout, code } = await runCommand(command, versionArgs ?? ['--version']);
      if (code !== 0) return null;
      const ver = parseVersion(stdout);
      return ver ? ver.join('.') : null;
    } catch { return null; }
  };
}

export function createIsAvailable(command: string, opts?: { timeout?: number }): () => Promise<boolean> {
  return async () => {
    try {
      const { code } = await runCommand(command, ['--version'], opts);
      return code === 0;
    } catch { return false; }
  };
}

export function createPlannerBase(config: PlannerBaseConfig): PlannerBackend {
  return {
    name: config.name,
    conversational: config.conversational ?? false,

    async plan(
      feature: string,
      projectDir: string,
      _config: Config,
      callbacks: PlannerCallbacks,
      skillsContext?: string,
    ): Promise<PlanResult> {
      const projectContext = buildProjectContextMarkdown(projectDir);
      let usage: PlannerTokenUsage | null = null;

      async function runPhase(phase: string, prompt: string, filename: string): Promise<string> {
        callbacks.onPhase?.(phase);
        const result = await config.invokePlan(prompt, projectDir, callbacks.onOutput, callbacks.onQuestion);
        if (result.usage) usage = accumulateUsage(usage, result.usage);
        writeSpecFile(projectDir, filename, result.text);
        return result.text;
      }

      const research = await runPhase('researching', buildResearchPrompt(feature, projectContext, skillsContext), 'research.md');
      const spec = await runPhase('specifying', buildSpecPrompt(feature, research), 'spec.md');
      const plan = await runPhase('planning', buildPlanPrompt(spec, projectContext, skillsContext), 'plan.md');
      const tasksMarkdown = await runPhase('generating-tasks', buildTasksPrompt(spec, plan), 'tasks.md');

      const tasks = parseTasks(tasksMarkdown);

      return { spec, plan, tasks, usage };
    },

    async quickPlan(
      feature: string,
      projectDir: string,
      _config: Config,
      callbacks: PlannerCallbacks,
    ): Promise<PlanResult> {
      const projectContext = buildProjectContextMarkdown(projectDir);
      const prompt = buildQuickPlanPrompt(feature, projectContext);

      callbacks.onPhase?.('quick-planning');
      const result = await config.invokePlan(prompt, projectDir, callbacks.onOutput);
      writeSpecFile(projectDir, 'tasks.md', result.text);

      const tasks = parseTasks(result.text);
      return { spec: '', plan: '', tasks, usage: result.usage };
    },

    async regenerate(
      prompt: string,
      artifactType: 'spec' | 'plan',
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<RegenerateResult> {
      const result = await config.invokeEscalate(prompt, projectDir, callbacks.onOutput);
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
      const result = await config.invokeEscalate(hintPrompt, projectDir, callbacks.onOutput);
      const success = config.escalateHintSuccess ? config.escalateHintSuccess(result) : true;
      return { success, output: result.text, code: null, usage: result.usage };
    },

    async escalateFull(
      task: Task,
      error: string,
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<EscalationResult> {
      const escalationPrompt = buildEscalationPrompt(task, task.currentCode ?? '', error);
      const result = await config.invokeEscalate(escalationPrompt, projectDir, callbacks.onOutput);

      const extracted = extractCode(result.text);
      if ('error' in extracted) {
        return { success: false, output: result.text, code: null, usage: result.usage };
      }

      if (config.escalateFullPostProcess) {
        return config.escalateFullPostProcess(task, result, extracted, projectDir);
      }

      return { success: true, output: result.text, code: extracted.code, usage: result.usage };
    },

    async isAvailable(): Promise<boolean> {
      return config.isAvailable();
    },

    async getVersion(): Promise<string | null> {
      return config.getVersion();
    },

    getPricing() {
      return getPlannerPricing(config.pricingKey);
    },
  };
}
