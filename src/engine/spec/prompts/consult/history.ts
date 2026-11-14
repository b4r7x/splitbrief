import { BOUNDS } from '../../../../core/pipeline-spec/bounds.js';
import type { ConsultSeat, ImplementerReport } from '../../../../core/schemas/consult.js';
import type { ConsultRecord } from '../../../../core/schemas/workflow/consult-record.js';
import { decisionLedgerText } from '../../../../core/state/lineage.js';
import { truncateByChars } from '../../../../utils/display-text/truncate.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { fenced } from '../builder.js';
import type { ConsultPromptInput } from './types.js';

export function consultAnswerDetail(answer: ConsultRecord['answer']): string {
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
    case 'cannot':
      return `cannot be done: ${action.reason}`;
    case 'accept':
      return `accepted the blockers: ${action.note}`;
    default:
      return assertNever(action);
  }
}

/** An older run's reviewer answered its fix tasks' consults, and its records name it. */
const ANSWER_SEAT: Record<ConsultSeat, string> = { plan: 'Planner', review: 'Reviewer' };

/**
 * The failed attempts and the earlier answers of the lineage, oldest first: each answer stands
 * before the attempts that followed it. An older answer that recorded no attempt count stands
 * after every attempt.
 */
function historyLines(input: ConsultPromptInput): string[] {
  const entries = [
    ...input.failedAttempts.map((failure) => ({
      at: failure.attempt,
      line: `- Attempt ${failure.attempt} (${failure.taskId} revision ${failure.revision}): ${failure.line}`,
    })),
    ...input.earlierConsults.map((record) => ({
      at: record.afterAttempt === undefined ? Number.POSITIVE_INFINITY : record.afterAttempt + 0.5,
      line:
        `- ${ANSWER_SEAT[record.seat ?? 'plan']} answer (${record.reason} · ${record.answer.answer.action} · revision ${record.revision}): ` +
        `${record.answer.answer.diagnosis} — ${consultAnswerDetail(record.answer)}`,
    })),
  ];
  return entries.toSorted((a, b) => a.at - b.at).map((entry) => entry.line);
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
        }\nDecisions: ${report.decisions.map(decisionLedgerText).join('; ') || 'none'}\nNotes: ${report.notes ?? 'none'}`;
  return ['## Implementer Report', fenced(detail)];
}

/** The names of the files a diff does not show, at most this many before a count. */
const LEFT_OUT_NAMES = 20;

/** The first `LEFT_OUT_NAMES` paths, then a count of the rest. */
function namedFiles(paths: readonly string[]): string {
  const names = paths.slice(0, LEFT_OUT_NAMES).map((path) => `\`${path}\``);
  const more = paths.length - names.length;
  return `${names.join(', ')}${more > 0 ? `, and ${more.toLocaleString('en-US')} more` : ''}`;
}

/**
 * The brief's file diffs in order, each whole, until `BOUNDS.consultDiffChars` is full. A first
 * file larger than the whole budget is cut to it. The files cut or left out are named, with a
 * count past `LEFT_OUT_NAMES`, for the seat to read in the workspace.
 */
function briefDiffLines(diffs: readonly { path: string; diff: string }[]): string[] {
  if (diffs.length === 0)
    return ['The files of this brief have no change since this task started.'];
  let used = 0;
  const overflow = diffs.findIndex((entry) => {
    used += entry.diff.length;
    return used > BOUNDS.consultDiffChars;
  });
  const whole = overflow === -1 ? diffs.length : overflow;
  const shown =
    whole === 0
      ? diffs.slice(0, 1).map((entry) => truncateByChars(entry.diff, BOUNDS.consultDiffChars))
      : diffs.slice(0, whole).map((entry) => entry.diff);
  const notShown = diffs.slice(whole).map((entry) => entry.path);
  if (notShown.length === 0) return [fenced(shown.join('\n'), 'diff')];
  return [
    fenced(shown.join('\n'), 'diff'),
    `The diff stops at ${BOUNDS.consultDiffChars.toLocaleString('en-US')} characters. Not shown in full: ${namedFiles(notShown)}. Read these files in the run workspace.`,
  ];
}

/** The brief's file diffs, then one line naming the other files the task changed. */
function diffLines(taskDiff: ConsultPromptInput['taskDiff']): string[] {
  if (taskDiff === null)
    return ['No diff of this task is available. Read the files in the run workspace.'];
  const { diffs, otherFiles } = taskDiff;
  if (diffs.length === 0 && otherFiles.length === 0)
    return ['This task has changed no file since it started.'];
  return [
    ...briefDiffLines(diffs),
    ...(otherFiles.length === 0
      ? []
      : [
          `This task also changed other files, not shown here: ${namedFiles(otherFiles)}. Read these files in the run workspace.`,
        ]),
  ];
}

export function attemptLines(input: ConsultPromptInput): string[] {
  return [
    '## Task Diff',
    'What is on disk now against the start of this task, for the files of this brief: the changes of all its attempts, revisions and split subtasks, not only the latest attempt.',
    ...diffLines(input.taskDiff),
    ...(input.failedAttempts.length === 0 && input.earlierConsults.length === 0
      ? []
      : [
          '## Brief History',
          'Each failed attempt of this task, with its first error line, and each earlier answer about it, oldest first. The attempts after an answer show what that answer did. Nothing counts your answers: SPLITBRIEF asks again after every failed attempt. When an earlier answer left the same failure, do not give it again: change the approach or the brief.',
          ...historyLines(input),
        ]),
    '## Failing Output',
    fenced(truncateByChars(input.failingOutput, BOUNDS.consultFailingOutputChars)),
    ...reportLines(input.report),
  ];
}
