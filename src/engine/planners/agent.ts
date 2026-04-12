import type { Config, Task } from '../../types.js';
import type { Planner, PlannerCallbacks, PlanResult } from './types.js';
import { createPlannerBase } from './base.js';
import { invokeCommandBasedRunner } from '../runners/command-based.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { extractQuestionsFromStream } from '../parsers/question-parser.js';
import { parseTasks } from '../spec/parser.js';
import { buildResearchPrompt } from '../spec/prompts/research.js';
import { buildSpecPrompt } from '../spec/prompts/spec.js';
import { buildPlanPromptFromSpec } from '../spec/prompts/plan.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import { buildEscalationPrompt } from '../spec/prompts/escalation.js';
import { buildQuickPlanPrompt } from '../spec/prompts/quick-plan.js';
import { buildProjectContextMarkdown } from './context.js';
import { readSpecFile } from '../../core/paths-io.js';
import { RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE } from '../../core/paths.js';
import { getChangedFiles } from '../../utils/git.js';

export function createAgentPlanner(config: Config): Planner {
  if (config.planner.kind !== 'agent') {
    throw new Error(`createAgentPlanner requires planner.kind = 'agent' (got ${config.planner.kind})`);
  }
  const plannerCfg = config.planner;
  const command = plannerCfg.command;
  const baseArgs = plannerCfg.args ?? [];
  const notFoundMessage = `Agent planner command not found: ${command}`;

  const invoke: Parameters<typeof createPlannerBase>[0]['invokePlan'] = async ({ prompt, projectDir, callbacks }) => {
    const result = await invokeCommandBasedRunner(
      {
        command,
        args: baseArgs,
        outputFormat: plannerCfg.outputFormat ?? 'text',
        extractsCode: false,
        notFoundMessage,
        detectChanges: async () => {
          const changed = await getChangedFiles(projectDir);
          return changed.length > 0;
        },
      },
      prompt,
      projectDir,
      callbacks.onOutput,
    );

    if (callbacks.onQuestion) {
      const questions = extractQuestionsFromStream(result.stdout);
      if (questions.length > 0) {
        callbacks.onQuestion(questions);
      }
    }

    return { text: result.stdout, usage: null };
  };

  const base = createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    hintSuccessMode: 'files',
    ...createCommandAvailability(command),
  });

  const readGeneratedFile = (projectDir: string, filename: string): string => {
    return readSpecFile(projectDir, filename) ?? '';
  };

  return {
    ...base,

    async plan(feature: string, projectDir: string, callbacks: PlannerCallbacks, skillsContext?: string): Promise<PlanResult> {
      const projectContext = await buildProjectContextMarkdown(projectDir);
      const phases: { text: string; filename: string }[] = [];

      async function runPhase(phase: string, prompt: string, filename: string): Promise<string> {
        callbacks.onPhase?.(phase);
        const result = await invoke({ prompt, projectDir, callbacks: { onOutput: callbacks.onOutput, onQuestion: callbacks.onQuestion } });
        phases.push({ text: result.text, filename });
        const generated = readGeneratedFile(projectDir, filename);
        return generated || result.text;
      }

      const research = await runPhase('researching', buildResearchPrompt(feature, projectContext, skillsContext), RESEARCH_FILE);
      const spec = await runPhase('specifying', buildSpecPrompt(feature, research), SPEC_FILE);
      const plan = await runPhase('planning', buildPlanPromptFromSpec(spec, projectContext, skillsContext), PLAN_FILE);
      const tasksMarkdown = await runPhase('generating-tasks', buildTasksPrompt(spec, plan), TASKS_FILE);

      const tasks = parseTasks(tasksMarkdown);

      return { spec, plan, tasks, usage: null, phases };
    },

    async quickPlan(feature: string, projectDir: string, callbacks: PlannerCallbacks): Promise<PlanResult> {
      const projectContext = await buildProjectContextMarkdown(projectDir);
      const prompt = buildQuickPlanPrompt(feature, projectContext);

      callbacks.onPhase?.('quick-planning');
      const result = await invoke({ prompt, projectDir, callbacks: { onOutput: callbacks.onOutput, onQuestion: callbacks.onQuestion } });

      const tasksContent = readGeneratedFile(projectDir, TASKS_FILE) || result.text;
      const tasks = parseTasks(tasksContent);

      return { spec: '', plan: '', tasks, usage: null, phases: [{ text: result.text, filename: TASKS_FILE }] };
    },

    async escalateFull(task: Task, error: string, projectDir: string, callbacks: { onOutput: (text: string) => void }) {
      const escalationPrompt = buildEscalationPrompt(task, task.currentCode ?? '', error);
      const result = await invoke({ prompt: escalationPrompt, projectDir, callbacks });
      const changedFiles = await getChangedFiles(projectDir);
      return { success: changedFiles.length > 0, output: result.text, code: null, usage: null };
    },
  };
}
