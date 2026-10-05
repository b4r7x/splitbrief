import type { Plan } from '../../../core/schemas/plan.js';
import type { ReviewVerdict, TriageInput } from '../../../core/schemas/review.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ConsultRecord, TriageRecord } from '../../../core/schemas/workflow.js';
import type { Finding } from '../../../core/review/verdict.js';
import {
  buildPrompt,
  instructionsSection,
  workspaceReadInstructions,
  type PromptPart,
} from './builder.js';

export type TriagePromptInput = Readonly<{
  workspaceDir: string;
  /** The run's plan: the criteria and checks every task serves. */
  plan: Plan | undefined;
  /** Every task of the run, with its status. */
  tasks: readonly Task[];
  /** The review's blocking findings, by id, in review order. */
  findings: readonly Finding[];
  verdict: ReviewVerdict;
  /** The operator inputs waiting for an answer. */
  inputs: readonly TriageInput[];
  /** The checks the review re-ran for its unverified claims, and what they found. */
  verification: ReadonlyArray<{
    id: string;
    status: 'pass' | 'fail' | 'unverified';
    output: string;
  }>;
  /** The run's consult records, oldest first. */
  earlierConsults: readonly ConsultRecord[];
  /** The run's earlier triage records, oldest first. */
  earlierTriage: readonly TriageRecord[];
  /** The user's planning answers, in the order they were given. */
  planningAnswers: ReadonlyArray<{ reply: string; answer: string }>;
  /** The fix cycle this triage starts. */
  cycle: number;
}>;

const TRIAGE_CONTRACT = `You are the run's planner. A final review of this run failed; SPLITBRIEF asks you to turn its blocking findings into the work that fixes them. This call is read-only: do not write, edit or delete any file, and do not run commands that change the project.

Answer with exactly one JSON object in the triage shape: \`{ "fixTasks": [...], "rejected": [...], "verify": [...], "ask": … }\`.
- \`fixTasks\` — 0 or more complete TaskSpecs, each carrying \`findingIds\` that name the findings it fixes. A fix task may edit any ordinary project file a finding needs, including a file no earlier task suggested.
- \`rejected\` — one \`{ "findingId", "reason" }\` for a finding that needs no work; the reason is the answer the next review reads.
- \`verify\` — one \`{ "findingId", "checkIds" }\` for a finding whose work may already be on disk; name registered run or task checks. Unverified and minor findings never become fix tasks.
- \`ask\` — \`{ "question", "whyOnlyUserCanAnswer" }\` or null. Use it only when the finding cannot be answered from the plan and the decisions: a change to what is built, not how.

The coverage rule: every blocking finding id and every pending input id appears in exactly one \`fixTasks[].findingIds\`, \`rejected[].findingId\` or \`verify[].findingId\`, unless \`ask\` is set. A review question is a finding like any other: answer it from the plan and the decisions when they answer it — reject it with that answer as the reason — and use \`ask\` only when only the user holds the answer.`;

function checkLine(check: Plan['checks'][number]): string {
  return `\`${check.id}\` (${check.kind} \`${check.value}\`${check.required ? '' : ', optional'})`;
}

function planSection(plan: Plan): PromptPart {
  return {
    heading: 'Plan',
    body: [
      '### Decisions',
      ...plan.decisions.map((decision) => `- ${decision.text}`),
      '### Criteria',
      ...plan.criteria.map(
        (criterion) =>
          `- **${criterion.id}**: ${criterion.text} — checks: ${criterion.checkIds.join(', ') || 'none'}`,
      ),
      '',
      '### Checks',
      ...plan.checks.map((check) => `- ${checkLine(check)}`),
    ].join('\n'),
  };
}

function taskSection(tasks: readonly Task[]): PromptPart {
  return {
    heading: 'Tasks',
    body: tasks.length === 0 ? 'None.' : JSON.stringify(tasks, null, 2),
  };
}

function findingLines(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'None.';
  return findings
    .map((finding) => {
      const lines = [
        `- **${finding.id}** (${finding.kind} · ${finding.severity}) — ${finding.text}`,
      ];
      if (finding.file !== null) {
        lines.push(`  File: ${finding.file}${finding.line === null ? '' : `:${finding.line}`}`);
      }
      if (finding.taskId !== null) lines.push(`  Task: ${finding.taskId}`);
      if (finding.criterionId !== null) lines.push(`  Criterion: ${finding.criterionId}`);
      if (finding.acceptance !== null) lines.push(`  Acceptance: ${finding.acceptance}`);
      return lines.join('\n');
    })
    .join('\n');
}

function inputLines(inputs: readonly TriageInput[]): string {
  if (inputs.length === 0) return 'None.';
  return inputs
    .map(
      (input) =>
        `- **${input.id}** (${input.source} · ${input.kind}) — ${input.text}${
          input.file === null ? '' : `\n  File: ${input.file}`
        }`,
    )
    .join('\n');
}

function verificationLines(verification: TriagePromptInput['verification']): string | undefined {
  if (verification.length === 0) return undefined;
  return verification
    .map(
      (entry) => `- ${entry.id}: ${entry.status}${entry.output === '' ? '' : ` — ${entry.output}`}`,
    )
    .join('\n');
}

function consultLines(records: readonly ConsultRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  return records
    .map(
      (record) =>
        `- ${record.taskId} · ${record.reason} → ${record.answer.answer.action}: ${record.answer.answer.diagnosis}`,
    )
    .join('\n');
}

function triageLines(records: readonly TriageRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  return records
    .map((record) => {
      const rejected = record.result.rejected
        .map((entry) => `${entry.findingId} rejected: ${entry.reason}`)
        .join('; ');
      const fixes = record.result.fixTasks.map((task) => task.title).join(', ');
      const verified = record.result.verify.map((entry) => entry.findingId).join(', ');
      const parts = [
        fixes === '' ? undefined : `fix tasks: ${fixes}`,
        verified === '' ? undefined : `verified: ${verified}`,
        rejected === '' ? undefined : rejected,
      ].filter((part): part is string => part !== undefined);
      return `- cycle ${record.cycle}: ${parts.join(' | ') || 'no outcome recorded'}${
        record.result.ask === null ? '' : ` | asked: ${record.result.ask.question}`
      }`;
    })
    .join('\n');
}

/**
 * The triage prompt: the plan and the tasks, the review's blocking findings and the pending
 * inputs, the checks the review re-ran, the run's consult and triage history, the user's
 * planning answers and the fix cycle this call starts. One call answers all of it.
 */
export function buildTriagePrompt(input: TriagePromptInput): string {
  const sections: PromptPart[] = [];
  if (input.plan !== undefined) sections.push(planSection(input.plan));
  sections.push(taskSection(input.tasks));
  sections.push({ heading: 'Review Results', body: JSON.stringify(input.verdict, null, 2) });
  sections.push({ heading: 'Blocking Findings', body: findingLines(input.findings) });
  sections.push({ heading: 'Pending Inputs', body: inputLines(input.inputs) });
  const verification = verificationLines(input.verification);
  if (verification !== undefined)
    sections.push({ heading: 'Review Verification', body: verification });
  const consults = consultLines(input.earlierConsults);
  if (consults !== undefined) sections.push({ heading: 'Earlier Consults', body: consults });
  const triage = triageLines(input.earlierTriage);
  if (triage !== undefined) sections.push({ heading: 'Earlier Triages', body: triage });
  if (input.planningAnswers.length > 0) {
    sections.push({
      heading: 'User Answers',
      body: input.planningAnswers
        .map((answer) => `- ${answer.reply} → ${answer.answer}`)
        .join('\n'),
    });
  }
  sections.push({ heading: 'Fix Cycle', body: `This triage starts fix cycle ${input.cycle}.` });
  sections.push(
    instructionsSection(`${TRIAGE_CONTRACT}\n\n${workspaceReadInstructions(input.workspaceDir)}`),
  );

  return buildPrompt({
    title: 'Review triage',
    intro:
      'The final review found blocking findings or a pending correction. Decide what work fixes them.',
    sections,
  });
}
