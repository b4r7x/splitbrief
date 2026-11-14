import type { Plan } from '../../../../core/schemas/plan.js';
import type { Check, Task } from '../../../../core/schemas/task.js';
import type { PromptPart } from '../builder.js';

function checkLine(check: Check): string {
  return `\`${check.id}\` (${check.kind} \`${check.value}\`)`;
}

function bullets(label: string, values: readonly string[]): string[] {
  if (values.length === 0) return [];
  return [`**${label}:**`, ...values.map((value) => `- ${value}`)];
}

export function decisionLines(plan: Plan): string[] {
  const decisions =
    plan.decisions.length === 0
      ? ['None.']
      : plan.decisions.map(
          (decision) =>
            `- ${decision.text}${decision.taskId === null ? '' : ` (${decision.taskId})`}`,
        );
  return decisions;
}

export function planSection(plan: Plan): PromptPart {
  return {
    heading: 'Plan',
    body: [
      '### Criteria',
      ...plan.criteria.map(
        (criterion) =>
          `- **${criterion.id}**: ${criterion.text} — checks: ${criterion.checkIds.join(', ') || 'none'}`,
      ),
      '',
      '### Checks',
      ...plan.checks.map((check) => `- ${checkLine(check)}`),
      '',
      '### Decisions',
      ...decisionLines(plan),
    ].join('\n'),
  };
}

function keyList(keys: Record<string, string[]> | undefined): string | undefined {
  const entries = Object.entries(keys ?? {}).filter(([, values]) => values.length > 0);
  if (entries.length === 0) return undefined;
  return entries.map(([id, values]) => `${id}: ${values.join(', ')}`).join('; ');
}

/** A fix task's structured red per finding: its own failures, and the whole red they came from. */
function fixFindingLines(task: Task): string[] {
  const lines = (task.fix?.findings ?? []).flatMap((finding) => {
    const failure = keyList(finding.failureKeys);
    const red = keyList(finding.redKeys);
    if (failure === undefined && red === undefined) return [];
    const parts = [
      ...(failure === undefined ? [] : [`this brief's failures: ${failure}`]),
      ...(red === undefined ? [] : [`the whole red: ${red}`]),
    ];
    return [`- **${finding.id}** ${parts.join('; ')}`];
  });
  return lines.length === 0
    ? []
    : [
        '',
        '### Fix findings',
        "Other failures are not this brief's job: their fix tasks or the next review answer them. Do not send the implementer after them.",
        ...lines,
      ];
}

export function taskBody(task: Task): string {
  return [
    `**Title**: ${task.title}`,
    `**Action**: ${task.action}`,
    `**Files**: ${task.suggestedFiles.map((file) => `\`${file}\``).join(', ')}`,
    `**Depends on**: ${task.dependsOn.join(', ') || 'nothing'}`,
    `**Criteria**: ${(task.criteria ?? []).join(', ') || 'none recorded'}`,
    '',
    '### Description',
    task.description,
    ...bullets('Tests', task.tests),
    ...bullets('Constraints', task.constraints),
    ...(task.checks === undefined || task.checks.length === 0
      ? []
      : ['', '### Checks', ...task.checks.map((check) => `- ${checkLine(check)}`)]),
    ...fixFindingLines(task),
  ].join('\n');
}

export function revisionSection(revision: Task): PromptPart {
  return {
    heading: `Revision ${revision.revision ?? 1} · ${revision.title}`,
    body: revisionBody(revision),
  };
}

function revisionBody(revision: Task): string {
  return [
    `**Action**: ${revision.action}`,
    `**Files**: ${revision.suggestedFiles.map((file) => `\`${file}\``).join(', ')}`,
    `**Criteria**: ${(revision.criteria ?? []).join(', ') || 'none recorded'}`,
    '',
    revision.description,
  ].join('\n');
}

export function otherTaskLines(tasks: readonly Task[]): string[] {
  return tasks.map((task) => `- **${task.id}** (${task.status}) — ${task.title}`);
}
