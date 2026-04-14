import type { Task, InvokeResult, TokenDelta } from '../../types.js';
import type { Planner, PlannerCallbacks, PlanResult, EscalationResult, RegenerateResult, PhaseResult, PlannerCapabilities } from './types.js';
import { buildResearchPrompt } from '../spec/prompts/research.js';
import { buildSpecPrompt } from '../spec/prompts/spec.js';
import { buildPlanPromptFromSpec } from '../spec/prompts/plan.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import { buildHintPrompt, buildEscalationPrompt } from '../spec/prompts/escalation.js';
import { buildQuickPlanPrompt } from '../spec/prompts/quick-plan.js';
import { parseTasks } from '../spec/parser.js';
import { RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE } from '../../core/paths.js';
import { extractCode } from '../parsers/response-extractor.js';
import { buildProjectContextMarkdown } from './context.js';
import { accumulateUsage } from '../streaming/output-parsers.js';
import { DEFAULT_AVAILABILITY } from '../../utils/availability.js';
import { getChangedFiles } from '../../utils/git.js';
import { createChangeDetector } from '../change-detection.js';

type InternalInvokeFn = (opts: {
  prompt: string;
  projectDir: string;
  callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion'>;
}) => Promise<InvokeResult>;

// invokeEscalate exists separately: Claude Code uses session-chaining for plan phases but one-shot for escalations.
export interface PlannerBaseConfig {
  invokePlan: InternalInvokeFn;
  invokeEscalate: InternalInvokeFn;
  isAvailable: () => Promise<boolean>;
  getVersion?: () => Promise<string | null>;
  capabilities: PlannerCapabilities;
  /**
   * How to determine whether escalateHint succeeded.
   * - 'text': non-empty stdout (API/streaming planners)
   * - 'files': git changed files (CLI/agent planners that write files directly)
   * Default: 'text'
   */
  hintSuccessMode?: 'text' | 'files';
  /**
   * Optional hook to resolve the phase output text. Backends that write files to disk
   * (e.g., agent planner) can override the default stdout-based result by reading
   * the generated file. Falls back to `resultText` when not provided.
   */
  readPhaseOutput?: (filename: string, resultText: string, projectDir: string) => string;
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
      const phases: PhaseResult[] = [];

      async function runPhase(phase: string, prompt: string, filename: string): Promise<string> {
        callbacks.onPhase?.(phase);
        const result = await config.invokePlan({
          prompt,
          projectDir,
          callbacks: { onOutput: callbacks.onOutput, onQuestion: callbacks.onQuestion },
        });
        if (result.usage) usage = accumulateUsage(usage, result.usage);
        const artifactText = config.readPhaseOutput
          ? config.readPhaseOutput(filename, result.text, projectDir)
          : result.text;
        const rawOutput = artifactText !== result.text ? result.text : undefined;
        phases.push({ text: artifactText, filename, rawOutput });
        return artifactText;
      }

      const research = await runPhase('researching', buildResearchPrompt(feature, projectContext, skillsContext), RESEARCH_FILE);
      const spec = await runPhase('specifying', buildSpecPrompt(feature, research), SPEC_FILE);
      const plan = await runPhase('planning', buildPlanPromptFromSpec(spec, projectContext, skillsContext), PLAN_FILE);
      const tasksMarkdown = await runPhase('generating-tasks', buildTasksPrompt(spec, plan), TASKS_FILE);

      const tasks = parseTasks(tasksMarkdown);

      return { spec, plan, tasks, usage, phases };
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

      const tasksContent = config.readPhaseOutput
        ? config.readPhaseOutput(TASKS_FILE, result.text, projectDir)
        : result.text;
      const tasks = parseTasks(tasksContent);
      const rawOutput = tasksContent !== result.text ? result.text : undefined;
      return { spec: '', plan: '', tasks, usage: result.usage, phases: [{ text: tasksContent, filename: TASKS_FILE, rawOutput }] };
    },

    async regenerate(
      prompt: string,
      _artifactType: 'spec' | 'plan',
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<RegenerateResult> {
      const result = await config.invokeEscalate({ prompt, projectDir, callbacks });
      return { text: result.text, usage: result.usage };
    },

    async escalateHint(
      task: Task,
      error: string,
      projectDir: string,
      callbacks: { onOutput: (text: string) => void },
    ): Promise<EscalationResult> {
      if (config.capabilities.supportsHintEscalation === false) {
        return { success: false, output: '', code: null, usage: null };
      }
      const hintPrompt = buildHintPrompt(task, error);
      const useFiles = config.hintSuccessMode === 'files';
      const detect = useFiles ? createChangeDetector('Hint escalation') : null;
      const filesBefore = useFiles ? await getChangedFiles(projectDir) : [];
      const result = await config.invokeEscalate({ prompt: hintPrompt, projectDir, callbacks });
      const success = detect
        ? (await detect(projectDir, filesBefore)).changed
        : result.text.length > 0;
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
    capabilities: config.capabilities,
  };
}
