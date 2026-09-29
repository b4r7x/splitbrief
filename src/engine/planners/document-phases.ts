import { MODES } from '../../core/pipeline-spec/modes.js';
import { plannerStepsFor } from '../../core/pipeline-spec/steps.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import { accumulateTokenUsage } from '../calls/usage.js';
import { buildProjectContextMarkdown } from './context.js';
import {
  buildProjectLanguageContext,
  extractLanguageFromResearch,
} from '../spec/prompts/language-context.js';
import { isPlannerDocumentCall } from './types.js';
import type {
  PhaseResult,
  PlanResult,
  Planner,
  PlannerCallbacks,
  PlannerDocumentCall,
} from './types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { error } from '../../utils/error.js';

/**
 * Runs a mode's document calls back to back and returns what they produced. No
 * state, no artifacts on disk, no gates: the durable form of this sequence is the
 * orchestrator's step loop. `splitbrief spec` is the one caller.
 */
export async function runDocumentPhases(opts: {
  planner: Planner;
  mode: WorkflowMode;
  feature: string;
  projectDir: string;
  callbacks: PlannerCallbacks;
  skillsContext?: string | undefined;
  codebaseContext?: string | undefined;
  trivial?: boolean | undefined;
}): Promise<PlanResult> {
  const { planner, mode, feature, projectDir, callbacks, skillsContext, codebaseContext } = opts;
  const projectContext = await buildProjectContextMarkdown(projectDir);
  const calls = plannerStepsFor(mode, 'none')
    .map((step) => step.call)
    .filter(isPlannerDocumentCall);

  const texts: Partial<Record<PlannerDocumentCall, string>> = {};
  const phases: PhaseResult[] = [];
  let languageContext = buildProjectLanguageContext(projectDir, undefined);
  let usage: TokenDelta | null = null;
  let tasks: PlanResult['tasks'] = [];

  for (const call of calls) {
    const result = await planner.runPhase({
      call,
      projectDir,
      callbacks,
      inputs: {
        feature,
        projectContext,
        languageContext,
        ...(texts.research !== undefined && { research: texts.research }),
        ...(texts.spec !== undefined && { spec: texts.spec }),
        ...(texts.plan !== undefined && { plan: texts.plan }),
        ...(skillsContext !== undefined && { skillsContext }),
        ...(codebaseContext !== undefined && { codebaseContext }),
        ...(call === 'tasks' && mode === 'quick'
          ? { quickPlan: { trivial: opts.trivial === true } }
          : {}),
        ...(call === 'tasks' && { briefCap: MODES[mode].briefCap }),
      },
    });
    if (result.kind === 'conversation') {
      throw error('planner-input-required', `The planner needs your reply: ${result.text}`, {
        call,
        text: result.text,
        questions: result.questions,
      });
    }
    texts[call] = result.text;
    phases.push(result.artifact);
    if (result.usage) usage = accumulateTokenUsage(usage, result.usage);
    if (result.tasks) tasks = result.tasks;
    if (call === 'research') {
      languageContext = buildProjectLanguageContext(
        projectDir,
        extractLanguageFromResearch(result.text),
      );
    }
  }

  return {
    spec: texts.spec ?? '',
    plan: texts.plan ?? '',
    tasks,
    usage,
    phases,
  };
}
