import type { ConsultReason, ImplementerReport } from '../../../core/schemas/consult.js';
import type { Plan } from '../../../core/schemas/plan.js';
import type { Check, Task } from '../../../core/schemas/task.js';
import type { ConsultRecord } from '../../../core/schemas/workflow.js';
import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
import { assertNever } from '../../../utils/type-guards.js';
import { truncateByChars } from '../../../utils/truncate.js';
import {
  buildPrompt,
  fenced,
  instructionsSection,
  workspaceReadInstructions,
  type PromptPart,
} from './builder.js';

export type ConsultPromptInput = Readonly<{
  workspaceDir: string;
  reason: ConsultReason;
  /** The run's plan: the criteria and checks every task serves. */
  plan: Plan | undefined;
  task: Task;
  /** The task's earlier revisions, oldest first; the current task travels as `task`. */
  revisions: readonly Task[];
  /** The diff the attempt produced, from its snapshot to now. */
  diff: string;
  failingOutput: string;
  report: ImplementerReport | null;
  /** The answers earlier consults of this lineage gave. */
  earlierConsults: readonly ConsultRecord[];
  /** Every task of the run except the one being consulted about. */
  otherTasks: readonly Task[];
  /** Text the operator queued during an earlier brief, delivered with the task it concerns. */
  userText?: string | undefined;
  /**
   * The planner's session already holds this run's plan and brief: send the new attempt's
   * evidence as a short turn instead of the whole prompt.
   */
  resumed?: boolean | undefined;
}>;

const REASON_TEXT: Record<ConsultReason, string> = {
  failed: 'The task failed: its last attempt or one of its checks did not pass.',
  blocked: 'The implementer stopped and needs a decision that is not its own to make.',
  stale:
    'The task went stale: files it captured moved under it since the brief was compiled. Only guidance or a rewritten task can answer this reason.',
  deviation:
    "The implementer reported new decisions. Confirm changes of how that keep every criterion, or ask the user about a change of what. Validation follows confirm; ask-user carries the user's answer into a retry.",
};

const CONSULT_CONTRACT = `You are the run's planner. SPLITBRIEF asks you, not the user, for the decision that unblocks this task. This call is read-only: do not write, edit or delete any file, and do not run commands that change the project.

Answer with exactly one JSON object \`{ "answer": { "diagnosis": …, "action": … } }\`. \`answer.diagnosis\` states what actually went wrong, in one or two sentences, and is always present. Exactly one action follows it:
- \`guidance\` — \`instructions\` the implementer retries with, and \`context\`: the project file or fact the retry needs attached, or null. The brief is kept.
- \`rewrite-task\` — \`task\`: one complete replacement TaskSpec that fixes the brief itself.
- \`split-task\` — \`tasks\`: 2 to 4 complete TaskSpecs that together replace the task.
- \`verify\` — \`checkIds\` and \`reason\`: re-run exactly those checks before any retry, for when the failure may predate this task's own edits.
- \`ask-user\` — \`question\`, \`whyOnlyUserCanAnswer\`, \`choices\` (or null) and \`default\` (or null): only when no other action can unblock the task and the user alone holds the missing decision.

The criteria rule: a rewrite or a split never drops a criterion id; a split never splits a subtask. Every criterion id the task serves stays with its replacement, or with the union of the split tasks, and each replacement keeps a complete, verifiable brief. The checks rule: a defective check command may be repaired under the same check id, but a rewrite or a split never drops a check id that one of the task's criteria names; removing the requirement it checks needs \`ask-user\`.`;

const RESUME_CONTRACT = `Answer again with exactly one JSON object in the consult shape: \`answer.diagnosis\` and exactly one action. The call stays read-only. The criteria rule still holds: a rewrite or a split never drops a criterion id, and a split never splits a subtask. The checks rule still holds too: a defective check command may be repaired under the same check id, but removing a check id a served criterion names needs \`ask-user\`.`;

const DECISION_CONFIRM_CONTRACT = `You are the run's planner. This call confirms the new decisions in the implementer's report before validation. This call is read-only: do not write, edit or delete any file, and do not run commands that change the project.

Answer with exactly one JSON object \`{ "answer": { "diagnosis": …, "action": … } }\`. \`answer.diagnosis\` states your assessment in one or two sentences. Answer with exactly one of these actions:
- \`confirm\` with the exact \`decisions\` list you accept. Accept only changes of how that keep every criterion. The accepted entries extend the plan's confirmed decisions ledger. An empty list is valid.
- \`ask-user\` with \`question\`, \`whyOnlyUserCanAnswer\`, \`choices\` (or null) and \`default\` (or null). A change of what is built is \`ask-user\`. The user's answer goes into the next retry.

Validation runs after a \`confirm\` answer. It has not run for this attempt yet. An \`ask-user\` answer sends this attempt to a retry without validation.`;

function checkLine(check: Check): string {
  return `\`${check.id}\` (${check.kind} \`${check.value}\`${check.required ? '' : ', optional'})`;
}

function bullets(label: string, values: readonly string[]): string[] {
  if (values.length === 0) return [];
  return [`**${label}:**`, ...values.map((value) => `- ${value}`)];
}

function decisionLines(plan: Plan): string[] {
  const decisions =
    plan.decisions.length === 0
      ? ['None.']
      : plan.decisions.map(
          (decision) =>
            `- ${decision.text}${decision.taskId === null ? '' : ` (${decision.taskId})`}`,
        );
  return decisions;
}

function planSection(plan: Plan): PromptPart {
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

function taskBody(task: Task): string {
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
  ].join('\n');
}

function revisionSection(revision: Task): PromptPart {
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

function consultAnswerDetail(answer: ConsultRecord['answer']): string {
  const action = answer.answer;
  switch (action.action) {
    case 'guidance':
      return action.instructions;
    case 'rewrite-task':
      return `replaced with "${action.task.title}"`;
    case 'split-task':
      return `split into ${action.tasks.map((task) => `${task.id} "${task.title}"`).join(', ')}`;
    case 'verify':
      return `verify ${action.checkIds.join(', ')}: ${action.reason}`;
    case 'ask-user':
      return `asked the user: ${action.question}`;
    case 'confirm':
      return `confirmed ${action.decisions.map((decision) => `${decision.what} — ${decision.why}`).join('; ')}`;
    default:
      return assertNever(action);
  }
}

function earlierConsultLines(records: readonly ConsultRecord[]): string[] {
  return records.map(
    (record) =>
      `- ${record.reason} · ${record.answer.answer.action} · revision ${record.revision}: ` +
      `${record.answer.answer.diagnosis} — ${consultAnswerDetail(record.answer)}`,
  );
}

function otherTaskLines(tasks: readonly Task[]): string[] {
  return tasks.map((task) => `- **${task.id}** (${task.status}) — ${task.title}`);
}

function reportLines(report: ImplementerReport | null): string[] {
  if (report === null) return [];
  const detail =
    report.status === 'blocked'
      ? `Blocked: ${report.question}\nFiles needed: ${report.filesNeeded.join(', ') || 'none named'}`
      : `Files changed: ${report.filesChanged.join(', ') || 'none named'}\nTouched not suggested: ${
          report.touchedNotSuggested
            .map((entry) => `${entry.file}${entry.reason === '' ? '' : ` (${entry.reason})`}`)
            .join(', ') || 'none'
        }\nDecisions: ${
          report.decisions.map((decision) => `${decision.what} — ${decision.why}`).join('; ') ||
          'none'
        }\nNotes: ${report.notes ?? 'none'}`;
  return ['## Implementer Report', fenced(detail)];
}

function attemptLines(input: ConsultPromptInput): string[] {
  return [
    '## Attempt Diff',
    input.diff.trim() === ''
      ? 'No diff was recorded for this attempt.'
      : fenced(input.diff, 'diff'),
    ...(input.reason === 'deviation'
      ? []
      : [
          '## Failing Output',
          fenced(truncateByChars(input.failingOutput, BOUNDS.consultFailingOutputChars)),
        ]),
    ...reportLines(input.report),
  ];
}

function reasonSection(input: ConsultPromptInput): PromptPart {
  return { heading: 'Reason', body: `${input.reason} — ${REASON_TEXT[input.reason]}` };
}

/** What the operator typed while earlier briefs ran, when it concerns this task. */
function operatorNotesPart(input: ConsultPromptInput): PromptPart[] {
  const text = input.userText?.trim();
  if (text === undefined || text === '') return [];
  return [{ heading: 'Operator Notes', body: text }];
}

/**
 * The consult prompt. A fresh session reads the whole prompt: the plan, the task and its
 * revisions, the attempt's evidence, the lineage's earlier answers and the reason. A session
 * that still holds the planning thread is sent the short resumed turn instead: the task, the
 * reason and the new attempt's evidence.
 */
export function buildConsultPrompt(input: ConsultPromptInput): string {
  if (input.reason === 'deviation') {
    return buildPrompt({
      title: 'Confirm reported decisions',
      intro: `Assess the new decisions ${input.task.id} reported against the plan and task below.`,
      sections: [
        ...(input.plan === undefined ? [] : [planSection(input.plan)]),
        {
          heading: `Task ${input.task.id} (revision ${input.task.revision ?? 1})`,
          body: taskBody(input.task),
        },
        reasonSection(input),
        ...operatorNotesPart(input),
        ...attemptLines(input),
        instructionsSection(
          `${DECISION_CONFIRM_CONTRACT}\n\n${workspaceReadInstructions(input.workspaceDir)}`,
        ),
      ],
    });
  }
  if (input.resumed === true) {
    return buildPrompt({
      title: 'Consult continued',
      intro: `The planner session already holds this run's plan and brief. ${input.task.id} needs another answer (reason: ${input.reason}).`,
      sections: [
        ...(input.plan === undefined
          ? []
          : [{ heading: 'Confirmed Decisions', body: decisionLines(input.plan).join('\n') }]),
        {
          heading: 'Task',
          body: `**${input.task.id}** (revision ${input.task.revision ?? 1}) — ${input.task.title}`,
        },
        reasonSection(input),
        ...operatorNotesPart(input),
        ...attemptLines(input),
        instructionsSection(
          `${RESUME_CONTRACT}\n\n${workspaceReadInstructions(input.workspaceDir)}`,
        ),
      ],
    });
  }

  const sections: PromptPart[] = [];
  if (input.plan !== undefined) sections.push(planSection(input.plan));
  sections.push({
    heading: `Task ${input.task.id} (revision ${input.task.revision ?? 1})`,
    body: taskBody(input.task),
  });
  for (const revision of input.revisions) sections.push(revisionSection(revision));
  sections.push(reasonSection(input));
  sections.push(...operatorNotesPart(input));
  sections.push(...attemptLines(input));
  if (input.earlierConsults.length > 0) {
    sections.push({
      heading: 'Earlier Consults on This Lineage',
      body: earlierConsultLines(input.earlierConsults).join('\n'),
    });
  }
  if (input.otherTasks.length > 0) {
    sections.push({ heading: 'Other Tasks', body: otherTaskLines(input.otherTasks).join('\n') });
  }
  sections.push(
    instructionsSection(`${CONSULT_CONTRACT}\n\n${workspaceReadInstructions(input.workspaceDir)}`),
  );

  return buildPrompt({
    title: 'Consult on a failing task',
    intro: `One task of this run did not land, and SPLITBRIEF asks you to decide ${input.task.id}'s next step from the evidence below.`,
    sections,
  });
}
