import type { TriageInput } from '../../../core/schemas/review.js';
import type { TriageRecord } from '../../../core/schemas/workflow.js';
import {
  buildPrompt,
  fenced,
  instructionsSection,
  skillsSection,
  type PromptPart,
} from './builder.js';

const REVIEW_INSTRUCTIONS = `Review the implementation diff against every acceptance criterion and requirement in the spec and task briefs. Be thorough but fair -- minor style differences are acceptable; missing functionality or incorrect behavior is not.

Validation claims are evidence-bound. The Checks Log section and the Reviewer checks section carry the run's command output: the checks of the plan and the tasks, and the commands you chose for this review. Any statement about a test, type check, lint or other command result must quote the relevant line verbatim from the Checks Log section (for example the test runner's own summary line); never report counts or totals that do not appear there. If you run additional checks yourself, present them separately as reviewer observations -- they do not replace the recorded results. If the Checks Log section is absent or contains no relevant execution, state that validation output was not recorded instead of asserting results.

A failure the Checks Log marks pre-existing was red at the run base before any task ran: report it as pre-existing and raise no finding against this run for it.`;

const PROVENANCE_INSTRUCTIONS = `Use the Changed Files provenance to distinguish recorded run effects from workspace context. Do not attribute the whole workspace diff to the implementer. Independent operator or tool-fix hunks are context, including when they share a declared file with run changes; unrelated defects in those hunks alone do not fail this run. Evaluate the requested behavior in the integrated current workspace, including cross-file dependencies. A regression caused by a run effect, a broken interaction with existing code, or an unmet acceptance criterion still fails review. Keep unknown and overlapping edits explicit; if missing provenance or context prevents a required judgment, report that limit and fail that criterion rather than assuming it passed.`;

const REVIEW_CHECKLIST = `1. **Acceptance Criteria**: Check each criterion from the spec and task briefs. Is it satisfied by the implementation?
2. **Functional Requirements**: Are all inputs handled? Is processing correct? Are outputs as specified?
3. **Error Handling**: Are error cases handled as specified?
4. **Edge Cases**: Are boundary conditions addressed?
5. **Type Safety**: Are types correct and complete?
6. **Code Quality**: Are there obvious bugs, security issues, or performance problems?`;

const REQUIRED_RESULTS = `Answer with one result per listed id, in the schema you were given. Every task not met and every failed criterion needs a blocking finding naming it. Mark a criterion unverified when no recorded evidence proves it, and name its checkIds. Verify a render only when its current-candidate images are attached and you critique the scenario. A manifest alone leaves the render unverified. Finding kinds are defect, plan-gap, unverified and question; minor findings are notes.`;

const FIX_WORK_CONTRACT = `This review call is read-only. Do not write, edit or delete any file, or run commands that change the project. Return the verdict and the fix work in one review_answer.

- fixTasks: complete TaskSpecs with findingIds. Each may edit any ordinary project file a finding needs, including a file no earlier task suggested.
- rejected: { findingId, reason } for a pending input that needs no work. Reject pending inputs only. A finding you would reject is not a blocking finding.
- verify: { findingId, checkIds } for a finding or input whose work may already be on disk. Name registered run or task checks.
- ask: { question, whyOnlyUserCanAnswer } or null. Use it only for a change to what is built that the plan and decisions cannot answer.

Unless ask is set, every blocking finding that is not unverified and every pending input id appears exactly once in fixTasks[].findingIds, rejected[].findingId or verify[].findingId. Unverified and minor findings never become fix tasks.`;

const VALIDATION_EVIDENCE_PREAMBLE = `The orchestrator ran these validation commands and recorded their output. This section is the authoritative record of validation results for this run.`;

/** The plan's own data: the criteria and the briefs the verdict must answer for. */
export type ReviewPlanData = {
  criteria: readonly { id: string; text: string; checkIds: readonly string[] }[];
  /** The decisions ledger the plan recorded; what the implementation may not deviate from. */
  decisions?: readonly { text: string; taskId: string | null }[] | undefined;
  tasks: readonly {
    id: string;
    status: 'done' | 'pending';
    title: string;
    intent: string;
    criteria: readonly string[];
    suggestedFiles: readonly string[];
    exclusions: readonly string[];
  }[];
};

export type ReviewFileDiff = { path: string; taskIds: readonly string[]; diff: string };

/** What a task wrote outside the set any brief suggested. */
export type ReviewTouchedNotSuggested = { taskId: string; files: readonly string[] };

function planBody(plan: ReviewPlanData): string {
  const lines = ['### Criteria', ''];
  if (plan.criteria.length === 0) {
    lines.push('None.');
  } else {
    for (const criterion of plan.criteria) {
      const checks =
        criterion.checkIds.length === 0
          ? 'no registered checks'
          : `checks: ${criterion.checkIds.join(', ')}`;
      lines.push(`- ${criterion.id}: ${criterion.text} (${checks})`);
    }
  }
  lines.push('', '### Tasks', '');
  if (plan.tasks.length === 0) {
    lines.push('None.');
  } else {
    for (const task of plan.tasks) {
      lines.push(`- ${task.id} [${task.status}] ${task.title}: ${task.intent}`);
      lines.push(`  - Criteria: ${task.criteria.join(', ') || 'none'}`);
      lines.push(`  - Suggested files: ${task.suggestedFiles.join(', ') || 'none'}`);
      lines.push(`  - Exclusions: ${task.exclusions.join(', ') || 'none'}`);
    }
  }
  lines.push('', '### Decisions', '');
  const decisions = plan.decisions ?? [];
  if (decisions.length === 0) {
    lines.push('None.');
  } else {
    for (const decision of decisions) {
      lines.push(`- ${decision.text}${decision.taskId === null ? '' : ` (${decision.taskId})`}`);
    }
  }
  return lines.join('\n');
}

function diffBody(entries: readonly ReviewFileDiff[], laterDiff: string | undefined): string {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`### ${entry.path} — ${entry.taskIds.join(', ')}`, '', fenced(entry.diff, 'diff'));
  }
  if (laterDiff) {
    lines.push(
      '### Changes after the last recorded task completion; authorship unknown',
      '',
      fenced(laterDiff, 'diff'),
    );
  }
  return lines.join('\n');
}

function touchedBody(entries: readonly ReviewTouchedNotSuggested[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.files.length === 0) continue;
    lines.push(`- ${entry.taskId}: ${entry.files.join(', ')}`);
  }
  return lines.length === 0 ? 'None.' : lines.join('\n');
}

function requiredResultsBody(
  taskIds: readonly string[],
  criterionIds: readonly string[],
  fixCycle: number | undefined,
  reviewKind: 'task' | 'final',
): string {
  const fixWorkContract =
    reviewKind === 'task'
      ? FIX_WORK_CONTRACT.replace(
          'every blocking finding that is not unverified',
          'every blocking finding inside the Review Scope that is not unverified',
        )
      : FIX_WORK_CONTRACT;
  return [
    REQUIRED_RESULTS,
    ...(fixCycle === undefined ? [] : [fixWorkContract]),
    '',
    `Task ids: ${taskIds.join(', ') || 'none'}`,
    `Criterion ids: ${criterionIds.join(', ') || 'none'}`,
  ].join('\n');
}

export type FinalReviewPromptInput = {
  spec: string;
  taskBriefs: string;
  reviewKind?: 'task' | 'final' | undefined;
  pendingInputs?: readonly TriageInput[] | undefined;
  fixCycle?: number | undefined;
  /** The one-shot review diff, used only when files are undefined. */
  diff?: string | undefined;
  files?: readonly ReviewFileDiff[] | undefined;
  laterDiff?: string | undefined;
  workspaceContext?: readonly ReviewFileDiff[] | undefined;
  trimmed?: string | undefined;
  /** The plan as data: the criteria with their checks, and the briefs. */
  plan?: ReviewPlanData | undefined;
  /** Per-task files the briefs did not suggest. */
  touchedNotSuggested?: readonly ReviewTouchedNotSuggested[] | undefined;
  /** The recorded check runs, one line per check id. */
  checkResults?: string | undefined;
  /** The run's consult records, in order. */
  consultLog?: string | undefined;
  /** The fix work, verification, rejections and questions of each review cycle. */
  triageLog?: string | undefined;
  /** What the operator answered during planning. */
  planningAnswers?: string | undefined;
  /** The ids the verdict must answer for; derived from `plan` when omitted. */
  taskIds?: readonly string[] | undefined;
  criterionIds?: readonly string[] | undefined;
  driftReport?: string | undefined;
  checksLog?: string | undefined;
  /** The render scenarios the checks log recorded, attached or as a manifest. */
  renders?: string | undefined;
  /**
   * What the run changed and what the diff below covers. A seat that reads no
   * files of its own is told the scope it is judging instead of inferring it.
   */
  changeCoverage?: string | undefined;
  skillsContext?: string | undefined;
};

function reviewScopeBody(
  opts: FinalReviewPromptInput,
  taskIds: readonly string[],
  criterionIds: readonly string[],
): string {
  if (opts.reviewKind !== 'task') {
    return "This is the final review. It judges the whole run: every task and every acceptance criterion, whatever each task's status.";
  }
  const pending = opts.plan?.tasks.filter((task) => task.status === 'pending') ?? [];
  return [
    'This is a task review. It judges only the reviewed tasks and the due criteria below. The final review judges the whole run later.',
    '',
    `Reviewed tasks: ${taskIds.join(', ') || 'none'}`,
    `Due criteria: ${criterionIds.join(', ') || 'none'}`,
    ...(pending.length === 0
      ? ['Pending tasks: none.']
      : [
          'Pending tasks (not built yet; context, never a missing implementation):',
          ...pending.map(
            (task) => `- ${task.id} ${task.title} — criteria ${task.criteria.join(', ') || 'none'}`,
          ),
        ]),
    '',
    'Raise a blocking finding only for work inside this scope, and name its task id or criterion id. Raise no finding for work a pending task owns. A finding that names no reviewed task or due criterion, or names a pending one, is recorded as a note outside the task review scope and gets no fix task.',
  ].join('\n');
}

export function buildFinalReviewPrompt(opts: FinalReviewPromptInput): string {
  const reviewKind = opts.reviewKind ?? 'final';
  const taskIds = opts.taskIds ?? opts.plan?.tasks.map((task) => task.id) ?? [];
  const criterionIds =
    opts.criterionIds ?? opts.plan?.criteria.map((criterion) => criterion.id) ?? [];
  const sections: PromptPart[] = [
    { heading: 'Specification', body: opts.spec },
    { heading: 'Task Briefs', body: opts.taskBriefs },
    ...(opts.fixCycle === undefined
      ? []
      : [
          reviewInputsSection(opts.pendingInputs ?? []),
          { heading: 'Fix Cycle', body: `This answer starts fix cycle ${opts.fixCycle}.` },
        ]),
    ...skillsSection(opts.skillsContext),
    { heading: 'Review Scope', body: reviewScopeBody(opts, taskIds, criterionIds) },
  ];
  if (opts.plan !== undefined) {
    sections.push({ heading: 'Plan', body: planBody(opts.plan) });
  }
  if (opts.changeCoverage) {
    sections.push({ heading: 'Changed Files', body: opts.changeCoverage });
  }
  sections.push({
    heading: 'Implementation Diff',
    body:
      opts.files === undefined
        ? fenced(opts.diff ?? '', 'diff')
        : diffBody(opts.files, opts.laterDiff),
  });
  if (opts.workspaceContext !== undefined && opts.workspaceContext.length > 0) {
    sections.push({
      heading: 'Workspace Context',
      body: fenced(opts.workspaceContext.map((file) => file.diff).join('\n'), 'diff'),
    });
  }
  if (opts.trimmed !== undefined) {
    sections.push({ heading: 'Trimmed for Size', body: opts.trimmed });
  }
  if (opts.touchedNotSuggested !== undefined) {
    sections.push({
      heading: 'Touched, Not Suggested',
      body: touchedBody(opts.touchedNotSuggested),
    });
  }
  if (opts.checkResults) {
    sections.push({ heading: 'Recorded Check Results', body: opts.checkResults });
  }
  if (opts.consultLog) {
    sections.push({ heading: 'Consult Log', body: opts.consultLog });
  }
  if (opts.triageLog) {
    sections.push({ heading: 'Triage Log', body: opts.triageLog });
  }
  if (opts.planningAnswers) {
    sections.push({ heading: 'Planning Answers', body: opts.planningAnswers });
  }
  if (opts.driftReport) {
    sections.push({ heading: 'Deterministic Drift Report', body: opts.driftReport });
  }
  if (opts.checksLog) {
    sections.push({
      heading: 'Checks Log',
      body: `${VALIDATION_EVIDENCE_PREAMBLE}\n\n${opts.checksLog}`,
    });
  }
  if (opts.renders) {
    sections.push({ heading: 'Renders', body: opts.renders });
  }
  const reviewInstructions =
    reviewKind === 'task'
      ? REVIEW_INSTRUCTIONS.replace(
          'Review the implementation diff against every acceptance criterion and requirement in the spec and task briefs.',
          'Review the implementation diff against each due acceptance criterion and the requirements of the reviewed tasks.',
        )
      : REVIEW_INSTRUCTIONS;
  const reviewChecklist =
    reviewKind === 'task'
      ? REVIEW_CHECKLIST.replace(
          'Check each criterion from the spec and task briefs.',
          'Check each due criterion and each reviewed task brief.',
        )
      : REVIEW_CHECKLIST;
  sections.push(
    instructionsSection(
      [reviewInstructions, ...(opts.files === undefined ? [] : [PROVENANCE_INSTRUCTIONS])].join(
        '\n\n',
      ),
    ),
    { heading: 'Review Checklist', body: reviewChecklist },
    {
      heading: 'Required Results',
      body: requiredResultsBody(taskIds, criterionIds, opts.fixCycle, reviewKind),
    },
  );
  return buildPrompt({
    title: reviewKind === 'task' ? 'Task Implementation Review' : 'Final Implementation Review',
    intro:
      (reviewKind === 'task'
        ? 'You are reviewing the completed work inside the Review Scope against its specification.'
        : 'You are reviewing a completed implementation against its specification.') +
      ' Your job is to verify that the implementation satisfies the spec and identify any issues. Treat error-level drift findings as review blockers unless you can clearly explain why they are false positives.',
    sections,
  });
}

export function reviewInputsSection(inputs: readonly TriageInput[]): string {
  return `## Pending Inputs\n${inputLines(inputs)}`;
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

export function triageLines(records: readonly TriageRecord[]): string | undefined {
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
        ...(record.verification ?? []).map(
          (entry) => `${entry.id}: ${entry.status} — ${entry.output}`,
        ),
      ].filter((part): part is string => part !== undefined);
      return `- cycle ${record.cycle}${record.reviewAt === undefined ? '' : ` (candidate reviewed at ${record.reviewAt})`}: ${parts.join(' | ') || 'no outcome recorded'}${
        record.result.ask === null ? '' : ` | asked: ${record.result.ask.question}`
      }`;
    })
    .join('\n');
}
