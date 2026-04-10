import type { Task, InvokeResult, TokenDelta } from '../../types.js';
import type { Planner, PlannerCallbacks, PlanResult, EscalationResult, RegenerateResult } from './types.js';
import { buildResearchPrompt } from '../spec/prompts/research.js';
import { buildSpecPrompt } from '../spec/prompts/spec.js';
import { buildPlanPromptFromSpec } from '../spec/prompts/plan.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import { buildHintPrompt, buildEscalationPrompt } from '../spec/prompts/escalation.js';
import { buildQuickPlanPrompt } from '../spec/prompts/quick-plan.js';
import { parseTasks } from '../spec/parser.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE } from '../../core/paths.js';
import { extractCode } from '../parsers/response-extractor.js';
import { buildProjectContextMarkdown } from './context.js';
import { accumulateUsage } from '../streaming/output-parsers.js';
import { DEFAULT_AVAILABILITY } from '../../utils/availability.js';

type InternalInvokeFn = (opts: {
  prompt: string;
  projectDir: string;
  callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion'>;
}) => Promise<InvokeResult>;

interface PlannerBaseConfig {
  invokePlan: InternalInvokeFn;
  invokeEscalate: InternalInvokeFn;
  isAvailable: () => Promise<boolean>;
  getVersion?: () => Promise<string | null>;
  escalateHintSuccess?: (result: InvokeResult) => boolean;
  // One consumer (claude-code) — justified for the pluggable backend architecture.
  escalateFullPostProcess?: (task: Task, result: InvokeResult, extracted: { code: string }, projectDir: string) => EscalationResult;
}

export function createPlannerBase(config: PlannerBaseConfig): Planner {
  return {
    async plan(
      feature: string,
      projectDir: string,
      callbacks: PlannerCallbacks,
      skillsContext?: string,
    ): Promise<PlanResult> {
      const projectContext = await buildProjectContextMarkdown(projectDir);
      let usage: TokenDelta | null = null;

      async function runPhase(phase: string, prompt: string, filename: string): Promise<string> {
        callbacks.onPhase?.(phase);
        const result = await config.invokePlan({
          prompt,
          projectDir,
          callbacks: { onOutput: callbacks.onOutput, onQuestion: callbacks.onQuestion },
        });
        if (result.usage) usage = accumulateUsage(usage, result.usage);
        writeSpecFile(projectDir, filename, result.text);
        return result.text;
      }

      const research = await runPhase('researching', buildResearchPrompt(feature, projectContext, skillsContext), RESEARCH_FILE);
      const spec = await runPhase('specifying', buildSpecPrompt(feature, research), SPEC_FILE);
      const plan = await runPhase('planning', buildPlanPromptFromSpec(spec, projectContext, skillsContext), PLAN_FILE);
      const tasksMarkdown = await runPhase('generating-tasks', buildTasksPrompt(spec, plan), TASKS_FILE);

      const tasks = parseTasks(tasksMarkdown);

      return { spec, plan, tasks, usage };
    },

    async quickPlan(
      feature: string,
      projectDir: string,
      callbacks: PlannerCallbacks,
    ): Promise<PlanResult> {
      const projectContext = await buildProjectContextMarkdown(projectDir);
      const prompt = buildQuickPlanPrompt(feature, projectContext);

      callbacks.onPhase?.('quick-planning');
      const result = await config.invokePlan({ prompt, projectDir, callbacks: { onOutput: callbacks.onOutput, onQuestion: callbacks.onQuestion } });
      writeSpecFile(projectDir, TASKS_FILE, result.text);

      const tasks = parseTasks(result.text);
      return { spec: '', plan: '', tasks, usage: result.usage };
    },

    async regenerate(
      prompt: string,
      artifactType: 'spec' | 'plan',
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<RegenerateResult> {
      const result = await config.invokeEscalate({ prompt, projectDir, callbacks });
      const filename = artifactType === 'spec' ? SPEC_FILE : PLAN_FILE;
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
      const result = await config.invokeEscalate({ prompt: hintPrompt, projectDir, callbacks });
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
      const result = await config.invokeEscalate({ prompt: escalationPrompt, projectDir, callbacks });

      const extracted = extractCode(result.text);
      if ('error' in extracted) {
        return { success: false, output: result.text, code: null, usage: result.usage };
      }

      if (config.escalateFullPostProcess) {
        return config.escalateFullPostProcess(task, result, extracted, projectDir);
      }

      return { success: true, output: result.text, code: extracted.code, usage: result.usage };
    },

    async review(
      prompt: string,
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<{ text: string; usage: TokenDelta | null }> {
      return config.invokeEscalate({ prompt, projectDir, callbacks });
    },

    ...DEFAULT_AVAILABILITY,
    isAvailable: config.isAvailable,
    ...(config.getVersion && { getVersion: config.getVersion }),
  };
}
