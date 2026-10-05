import type { PlanDecision, PlanProposal, TaskSpec } from '../../core/schemas/plan.js';
import { formatCheck } from './plan-tasks.js';

function section(heading: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [heading, '', ...lines, ''];
}

/** One decisions line: a proposal's plain string, or a ledger entry with its task id. */
function decisionLine(decision: PlanDecision | string): string {
  return typeof decision === 'string'
    ? `- ${decision}`
    : `- ${decision.text}${decision.taskId === null ? '' : ` (${decision.taskId})`}`;
}

function taskLines(task: TaskSpec): string[] {
  const list = (label: string, items: readonly string[]) =>
    items.length === 0 ? [] : [`- ${label}: ${items.join(', ')}`];
  return [
    `#### ${task.id} ${task.title}`,
    '',
    task.intent,
    '',
    ...list('Criteria', task.criteria),
    ...list('Checks', task.checks.map(formatCheck)),
    ...list('Suggested files', task.suggestedFiles),
    ...list('Context files', task.contextFiles),
    ...list('Depends on', task.dependsOn),
    '',
  ];
}

/** Every protected operation the plan lists, with the task that needs it. Approving confirms them. */
export function planProtectedOperations(
  plan: PlanProposal,
): { taskId: string; operation: string; path: string }[] {
  return plan.tasks.flatMap((task) =>
    (task.protectedOperations ?? []).map((op) => ({ taskId: task.id, ...op })),
  );
}

/** `plan.md`, rendered from `plan.json` for people. Nothing parses it back. */
export function formatPlanMarkdown(plan: PlanProposal): string {
  const batches = [...new Set(plan.tasks.map((task) => task.batch))].sort((a, b) => a - b);
  // No `# Plan` heading: the card's frame already names plan.md, and on a short terminal the
  // heading would be all the card shows.
  return [
    plan.summary,
    '',
    // Protected operations stand right under the summary, not below the fold.
    ...section(
      '## Protected operations',
      planProtectedOperations(plan).map((op) => `- ${op.taskId}: ${op.operation} ${op.path}`),
    ),
    ...section('## Decisions', plan.decisions.map(decisionLine)),
    ...section(
      '## Criteria',
      plan.criteria.map(
        (criterion) =>
          `- ${criterion.id}: ${criterion.text} (checks: ${criterion.checkIds.join(', ')})`,
      ),
    ),
    ...section(
      '## Run checks',
      plan.checks.map((check) => `- ${formatCheck(check)}`),
    ),
    '## Tasks',
    '',
    ...batches.flatMap((batch) => [
      `### Batch ${batch}`,
      '',
      ...plan.tasks.filter((task) => task.batch === batch).flatMap(taskLines),
    ]),
  ].join('\n');
}
