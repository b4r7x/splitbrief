import type { WorkflowState } from '../../../core/schemas/workflow/state.js';

/** The recorded check runs: what each brief's checks returned, then the plan's. */
export function reviewCheckResults(state: WorkflowState): string {
  const lines: string[] = [];
  for (const task of state.tasks) {
    for (const result of task.checkResults ?? []) {
      lines.push(`- ${task.id} check ${result.id}: ${result.status}`);
    }
  }
  const recorded = new Map(
    state.tasks.flatMap((task) => task.checkResults ?? []).map((result) => [result.id, result]),
  );
  for (const check of state.plan?.checks ?? []) {
    const result = recorded.get(check.id);
    lines.push(
      `- plan check ${check.id}: ${result === undefined ? 'not recorded' : result.status}`,
    );
  }
  return lines.join('\n');
}

export function reviewConsultLog(state: WorkflowState): string {
  const lines: string[] = [];
  for (const lineage of Object.values(state.lineages ?? {})) {
    for (const record of lineage.consultRecords) {
      lines.push(
        `- ${record.at} ${record.taskId}: ${record.reason} → ${record.action}: ${record.diagnosis}`,
      );
    }
  }
  return lines.join('\n');
}

export function reviewPlanningAnswers(state: WorkflowState): string {
  return (state.userAnswers ?? [])
    .map((answer) => `- ${answer.reply} → ${answer.answer}`)
    .join('\n');
}
