import { isTaskCompleted } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { lineageIdOf } from '../../core/state/task-insert.js';
import { fenced } from '../spec/prompts/builder.js';
import type { ReviewPlanData } from '../spec/prompts/review.js';

/** The plan's own data as the review prompt presents it. */
export function reviewPlanData(state: WorkflowState): ReviewPlanData {
  return {
    criteria: (state.plan?.criteria ?? []).map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      checkIds: criterion.checkIds,
    })),
    decisions: state.plan?.decisions ?? [],
    tasks: state.tasks.map((task) => ({
      id: task.id,
      lineageId: lineageIdOf(task),
      status: isTaskCompleted(task.status) ? 'done' : 'pending',
      title: task.title,
      intent: task.description,
      steps: task.implementationSteps,
      criteria: task.criteria ?? [],
      suggestedFiles: task.suggestedFiles,
      exclusions: task.exclusions ?? task.scope?.outOfBounds ?? [],
    })),
  };
}

/** Each brief's operator-instruction log, fenced under the task its lineage started from. */
export function reviewOperatorInstructions(
  state: WorkflowState,
  taskIds?: readonly string[],
): string {
  const lineages =
    taskIds === undefined
      ? undefined
      : new Set<string>(state.tasks.filter((task) => taskIds.includes(task.id)).map(lineageIdOf));
  return Object.entries(state.lineages ?? {})
    .filter(([taskId]) => lineages === undefined || lineages.has(taskId))
    .flatMap(([taskId, lineage]) =>
      (lineage.corrections ?? []).map((text) => `${taskId}:\n${fenced(text)}`),
    )
    .join('\n\n');
}
