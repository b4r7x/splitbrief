import { type PromptPart, skillsSection, instructionsSection, buildPrompt } from '../builder.js';
import { GIT_READ_ONLY_RULE } from '../system.js';
import {
  reviewInputsSection,
  changeSections,
  changeFileBody,
  touchedBody,
  requiredResultsBody,
} from './changes.js';
import { planBody, operatorInstructionsBody } from './plan.js';
import type { FinalReviewPromptInput } from './types.js';

const REVIEW_INSTRUCTIONS = `Review the implementation diff against every acceptance criterion and requirement in the spec and task briefs. Be thorough but fair -- minor style differences are acceptable; missing functionality or incorrect behavior is not.

Validation claims are evidence-bound. The Checks Log section and the Reviewer checks section carry the run's command output: the checks of the plan and the tasks, and the project gate the plan names. Any statement about a test, type check, lint or other command result must quote the relevant line verbatim from the Checks Log section (for example the test runner's own summary line); never report counts or totals that do not appear there. If you run additional checks yourself, present them separately as reviewer observations -- they do not replace the recorded results. If the Checks Log section is absent or contains no relevant execution, state that validation output was not recorded instead of asserting results.

A failure the Checks Log marks pre-existing was red at the run base before any task ran: report it as pre-existing and raise no finding against this run for it.

A check marked refused, not-runnable or unknown did not run: SPLITBRIEF refused its command or could not start it. It is neither a pass nor a failure, so raise no finding for it. Mark a criterion that only such a check would verify unverified.

${GIT_READ_ONLY_RULE}.`;

const PROVENANCE_INSTRUCTIONS = `Use the Changed Files provenance to distinguish recorded run effects from workspace context. Do not attribute the whole workspace diff to the implementer. Independent operator or tool-fix hunks are context, including when they share a declared file with run changes; unrelated defects in those hunks alone do not fail this run. Evaluate the requested behavior in the integrated current workspace, including cross-file dependencies. A regression caused by a run effect, a broken interaction with existing code, or an unmet acceptance criterion still fails review. Keep unknown and overlapping edits explicit; if missing provenance or context prevents a required judgment, report that limit and fail that criterion rather than assuming it passed.`;

const REVIEW_CHECKLIST = `1. **Acceptance Criteria**: Check each criterion from the spec and task briefs. Is it satisfied by the implementation?
2. **Functional Requirements**: Are all inputs handled? Is processing correct? Are outputs as specified?
3. **Error Handling**: Are error cases handled as specified?
4. **Edge Cases**: Are boundary conditions addressed?
5. **Type Safety**: Are types correct and complete?
6. **Code Quality**: Are there obvious bugs, security issues, or performance problems?
7. **Test Strength**: For each test a task adds, check that the test fails when the behaviour the task names breaks. A test that still passes with that behaviour broken is a finding.`;

const VALIDATION_EVIDENCE_PREAMBLE = `The orchestrator ran these validation commands and recorded their output. This section is the authoritative record of validation results for this run.`;

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
  sections.push(
    ...(opts.changeFile === undefined
      ? changeSections(opts)
      : [{ heading: 'Implementation Diff', body: changeFileBody(opts.changeFile) }]),
  );
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
  if (opts.operatorInstructions) {
    sections.push({
      heading: 'Operator Instructions',
      body: operatorInstructionsBody(opts.operatorInstructions),
    });
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
        ).replace(
          "The Checks Log section and the Reviewer checks section carry the run's command output: the checks of the plan and the tasks, and the project gate the plan names.",
          "The Checks Log section carries the run's command output: the checks of the plan and the tasks. A task review runs no project gate: a reviewer check in the Checks Log comes from an earlier final review or from a fix task.",
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
      [
        reviewInstructions,
        ...(opts.files !== undefined || opts.changeFile?.provenance === true
          ? [PROVENANCE_INSTRUCTIONS]
          : []),
      ].join('\n\n'),
    ),
    { heading: 'Review Checklist', body: reviewChecklist },
    {
      heading: 'Required Results',
      body: requiredResultsBody(
        taskIds,
        opts.plan?.tasks.filter((task) => taskIds.includes(task.id)) ?? [],
        criterionIds,
        opts.checkIds,
        opts.fixCycle,
        reviewKind,
        opts.writesFiles,
      ),
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
