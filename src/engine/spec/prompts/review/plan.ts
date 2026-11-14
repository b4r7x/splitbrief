import type { ReviewPlanData } from './types.js';

const DECLARED_DECISION_NOTE =
  'The implementer of a task declared each decision that has a task id. Nobody confirmed these decisions: judge them against the criteria and the code.';

export function planBody(plan: ReviewPlanData, taskIds?: readonly string[]): string {
  const tasks =
    taskIds === undefined ? plan.tasks : plan.tasks.filter((task) => taskIds.includes(task.id));
  const criteria =
    taskIds === undefined
      ? plan.criteria
      : plan.criteria.filter((criterion) =>
          tasks.some((task) => task.criteria.includes(criterion.id)),
        );
  const lines = ['### Criteria', ''];
  if (criteria.length === 0) {
    lines.push('None.');
  } else {
    for (const criterion of criteria) {
      const checks =
        criterion.checkIds.length === 0
          ? 'no registered checks'
          : `checks: ${criterion.checkIds.join(', ')}`;
      lines.push(`- ${criterion.id}: ${criterion.text} (${checks})`);
    }
  }
  lines.push('', '### Tasks', '');
  if (tasks.length === 0) {
    lines.push('None.');
  } else {
    for (const task of tasks) {
      lines.push(`- ${task.id} [${task.status}] ${task.title}: ${task.intent}`);
      lines.push(task.steps.length === 0 ? '  - Steps: none' : '  - Steps:');
      for (const [index, step] of task.steps.entries()) {
        lines.push(`    ${index + 1}. ${step}`);
      }
      lines.push(`  - Criteria: ${task.criteria.join(', ') || 'none'}`);
      lines.push(`  - Suggested files: ${task.suggestedFiles.join(', ') || 'none'}`);
      lines.push(`  - Exclusions: ${task.exclusions.join(', ') || 'none'}`);
    }
  }
  lines.push('', '### Decisions', '');
  const decisions = (plan.decisions ?? []).filter(
    (decision) =>
      taskIds === undefined ||
      decision.taskId === null ||
      tasks.some((task) => task.id === decision.taskId || task.lineageId === decision.taskId),
  );
  if (decisions.length === 0) {
    lines.push('None.');
  } else {
    if (decisions.some((decision) => decision.taskId !== null)) {
      lines.push(DECLARED_DECISION_NOTE, '');
    }
    for (const decision of decisions) {
      lines.push(`- ${decision.text}${decision.taskId === null ? '' : ` (${decision.taskId})`}`);
    }
  }
  return lines.join('\n');
}

export function operatorInstructionsBody(instructions: string): string {
  return `The user gave these instructions to a task after its brief was written. They are the user's own decisions: work that carries one out is in scope.\n\n${instructions}`;
}
