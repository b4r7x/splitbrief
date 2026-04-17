import type { WorkflowState, Task } from '../../core/types/state-actions.js';
import type { OrchestratorCallbacks } from '../../core/types/events.js';
import type { Planner } from '../planners/types.js';
import { readSpecFileOrEmpty, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE } from '../../core/paths.js';
import { parseTasks } from '../spec/parser.js';
import { buildPlanPrompt } from '../spec/prompts/plan.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import { buildProjectContextMarkdown } from '../planners/context.js';
import { runPlannerReview } from './helpers.js';
import { drainQueue, formatDrainedMessages } from './queue-drain.js';

export type RegenerateFromFeedbackCtx = {
  projectDir: string;
  sessionId: string;
  planner: Planner;
  callbacks: OrchestratorCallbacks;
  state: WorkflowState;
  metadata: SpecMetadata;
  skillsContext?: string | undefined;
  /** When provided, used as the plan text for tasks regeneration (avoids reading PLAN_FILE from disk). */
  planOverride?: string | undefined;
};

type PlanRegenResult = { kind: 'plan'; state: WorkflowState; plan: string };
type TasksRegenResult = { kind: 'tasks'; state: WorkflowState; tasks: Task[] };

/**
 * Unified regeneration for plan.md or tasks.md driven by the current spec/plan on disk.
 * Drains any queued messages before calling the planner, then writes the resulting artifact
 * to disk via runPlannerReview. Callers handle emitting higher-level orchestrator events
 * around the regeneration.
 */
export async function regenerateFromFeedback(kind: 'plan', ctx: RegenerateFromFeedbackCtx): Promise<PlanRegenResult>;
export async function regenerateFromFeedback(kind: 'tasks', ctx: RegenerateFromFeedbackCtx): Promise<TasksRegenResult>;
export async function regenerateFromFeedback(
  kind: 'plan' | 'tasks',
  ctx: RegenerateFromFeedbackCtx,
): Promise<PlanRegenResult | TasksRegenResult> {
  const { projectDir, sessionId, planner, callbacks, metadata, skillsContext, planOverride } = ctx;
  let { state } = ctx;

  const drain = drainQueue(projectDir, sessionId, state, callbacks);
  state = drain.state;
  const prefix = drain.messages.length > 0 ? formatDrainedMessages(drain.messages) : '';

  const spec = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);

  if (kind === 'plan') {
    const projectContext = await buildProjectContextMarkdown(projectDir);
    const basePrompt = buildPlanPrompt({ content: spec, hasClarifications: spec.includes('## Clarifications') }, projectContext, skillsContext);
    const result = await runPlannerReview({
      planner,
      prompt: prefix ? prefix + basePrompt : basePrompt,
      projectDir,
      sessionId,
      callbacks,
      state,
      metadata,
      writeTo: PLAN_FILE,
    });
    return { kind: 'plan', state: result.state, plan: result.text };
  }

  const plan = planOverride ?? readSpecFileOrEmpty(projectDir, sessionId, PLAN_FILE);
  const basePrompt = buildTasksPrompt(spec, plan);
  const result = await runPlannerReview({
    planner,
    prompt: prefix ? prefix + basePrompt : basePrompt,
    projectDir,
    sessionId,
    callbacks,
    state,
    metadata,
    writeTo: TASKS_FILE,
  });
  return { kind: 'tasks', state: result.state, tasks: parseTasks(result.text) };
}
