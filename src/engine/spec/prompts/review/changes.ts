import type { TriageInput } from '../../../../core/schemas/review/verdict.js';
import type { ImplementerWriteMode } from '../../../../core/schemas/runner/implementer.js';
import type { TriageRecord } from '../../../../core/schemas/workflow/review-record.js';
import { fenced, type PromptSection } from '../builder.js';
import { DIRECT_WRITER_TASK_RULE, TASK_CMD_CHECK_RULE } from '../plan-session.js';
import type {
  ReviewFileDiff,
  ReviewChange,
  ReviewChangeFile,
  ReviewTouchedNotSuggested,
} from './types.js';

const REQUIRED_RESULTS = `Answer with one result per listed id, in the schema you were given. Every task not met needs a blocking finding whose taskId is that task's id, and every failed criterion needs a blocking finding whose criterionId is that criterion's id. A red pending input already blocks the review: do not restate it as a new finding. When a failed criterion or a task not met needs a finding for that input, give the input's id to one such finding only. A finding a fix cycle left open keeps its id, and a new finding never takes an id the triage log names. Mark a criterion unverified when no recorded evidence proves it, and name its checkIds. Verify a render only when its current-candidate images are attached and you critique the scenario. A manifest alone leaves the render unverified. Finding kinds are defect, plan-gap, unverified and question; minor findings are notes.`;

function fixWorkContract(writesFiles: ImplementerWriteMode | undefined): string {
  const sizing = writesFiles === 'direct' ? ` ${DIRECT_WRITER_TASK_RULE}` : '';
  return `This review call is read-only. Do not write, edit or delete any file, or run commands that change the project. Return the verdict and the fix work in one review_answer.

- fixTasks: complete TaskSpecs with findingIds. Each may edit any ordinary project file a finding needs, including a file no earlier task suggested. ${TASK_CMD_CHECK_RULE}${sizing}
- rejected: { findingId, reason } for a pending input that needs no work, for example a red check that fails for a reason outside this run. A rejected red check stops blocking the review, and the user sees the reason. Reject pending inputs only. An Apply conflict always needs a fix task. A finding you would reject is not a blocking finding.
- ask: { question, whyOnlyUserCanAnswer } or null. Use it only for a change to what is built that the plan and decisions cannot answer.

Unless ask is set, every blocking finding that is not unverified appears exactly once in fixTasks[].findingIds or rejected[].findingId. Every pending input id appears exactly once in rejected[].findingId, or in the findingIds of one or more fix tasks. A blocking finding under a pending input's id follows this rule. With ask set, these two rules do not apply. The acceptance of each finding a fix task fixes names only the failures that task fixes; the other failures of the same command belong to their own fix tasks or to the next review. Unverified and minor findings never become fix tasks.`;
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

export function changeSections(change: ReviewChange): PromptSection[] {
  return [
    {
      heading: 'Implementation Diff',
      body:
        change.files === undefined
          ? fenced(change.diff ?? '', 'diff')
          : diffBody(change.files, change.laterDiff),
    },
    ...(change.workspaceContext !== undefined && change.workspaceContext.length > 0
      ? [
          {
            heading: 'Workspace Context',
            body: fenced(change.workspaceContext.map((file) => file.diff).join('\n'), 'diff'),
          },
        ]
      : []),
  ];
}

/** The change sections of the review prompt as one text, for the change file. */
export function reviewChangeText(change: ReviewChange): string {
  return changeSections(change)
    .map((section) => `## ${section.heading}\n${section.body}`)
    .join('\n\n');
}

export function changeFileBody(file: ReviewChangeFile): string {
  const holds = file.provenance
    ? 'one block per changed file with the tasks that changed it, then the changes after the last recorded task completion and the Workspace Context, when present'
    : 'one diff of every changed file';
  return `The change under review is in \`${file.path}\`: ${holds}. Read this file whole, then read the changed files themselves in the workspace. Do not report as verified anything you did not read.`;
}

export function touchedBody(entries: readonly ReviewTouchedNotSuggested[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.files.length === 0) continue;
    lines.push(`- ${entry.taskId}: ${entry.files.join(', ')}`);
  }
  return lines.length === 0 ? 'None.' : lines.join('\n');
}

export function requiredResultsBody(
  taskIds: readonly string[],
  tasks: readonly { id: string; title: string }[],
  criterionIds: readonly string[],
  checkIds: readonly string[] | undefined,
  fixCycle: number | undefined,
  reviewKind: 'task' | 'final',
  writesFiles: ImplementerWriteMode | undefined,
): string {
  const contract = fixWorkContract(writesFiles);
  const scopedContract =
    reviewKind === 'task'
      ? contract.replace(
          'every blocking finding that is not unverified',
          'every blocking finding inside the Review Scope that is not unverified',
        )
      : contract;
  // Each sentence names only the lists this prompt prints: Check ids when the caller passes them,
  // Pending Inputs and the fix work in a fix cycle.
  const findingFields =
    checkIds === undefined
      ? "a finding's taskId names only ids from Task ids, and its criterionId names only ids from Criterion ids"
      : "a finding's taskId names only ids from Task ids, its criterionId names only ids from Criterion ids, and its checkIds name only ids from Check ids";
  const findingRule = `Each id field takes ids from one list, never text: ${findingFields}${
    fixCycle === undefined ? '' : '; a rejected findingId names only Pending Inputs ids'
  }.${
    fixCycle === undefined || checkIds === undefined
      ? ''
      : ' A pending input id, for example V4.1, is not a check id: a finding for input V4.1 names its check V4.'
  }`;
  return [
    REQUIRED_RESULTS,
    ...(fixCycle === undefined ? [] : [scopedContract]),
    '',
    `Task ids: ${taskIds.join(', ') || 'none'}`,
    `Criterion ids: ${criterionIds.join(', ') || 'none'}`,
    ...(checkIds === undefined ? [] : [`Check ids: ${checkIds.join(', ') || 'none'}`]),
    findingRule,
    ...(fixCycle === undefined
      ? []
      : [
          "A fix task's criteria name only ids from Criterion ids, and its findingIds name only the blocking finding ids of this answer and the Pending Inputs ids. Write the words of a fix in the finding's acceptance and in the fix task's intent and steps.",
        ]),
    ...(tasks.length === 0
      ? []
      : [
          '',
          "Write each task's note about that task's own work:",
          ...tasks.map((task) => `- ${task.id}: ${task.title}`),
        ]),
  ].join('\n');
}

export function reviewInputsSection(inputs: readonly TriageInput[]): string {
  return `## Pending Inputs\n${inputLines(inputs)}`;
}

function inputLines(inputs: readonly TriageInput[]): string {
  if (inputs.length === 0) return 'None.';
  return inputs
    .map((input) => {
      const checkIds = input.checkIds ?? [];
      const [headline = '', ...details] = input.text.split('\n');
      const text =
        checkIds.length === 0
          ? input.text
          : [`${headline} (checks: ${checkIds.join(', ')})`, ...details].join('\n');
      return `- **${input.id}** (${input.source} · ${input.kind}) — ${text}${
        input.file === null ? '' : `\n  File: ${input.file}`
      }`;
    })
    .join('\n');
}

export function triageLines(records: readonly TriageRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  return records
    .map((record) => {
      const rejected = record.result.rejected
        .map((entry) => `${entry.findingId} rejected: ${entry.reason}`)
        .join('; ');
      const fixes = record.result.fixTasks
        .map((task) => `${task.title} (${task.findingIds.join(', ')})`)
        .join(', ');
      const parts = [
        fixes === '' ? undefined : `fix tasks: ${fixes}`,
        rejected === '' ? undefined : rejected,
      ].filter((part): part is string => part !== undefined);
      return `- cycle ${record.cycle}${record.reviewAt === undefined ? '' : ` (candidate reviewed at ${record.reviewAt})`}: ${parts.join(' | ') || 'no outcome recorded'}${
        record.result.ask === null ? '' : ` | asked: ${record.result.ask.question}`
      }`;
    })
    .join('\n');
}
