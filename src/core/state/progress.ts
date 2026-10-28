import { BOUNDS } from '../pipeline-spec/bounds.js';
import { pairFailureKeys } from '../review/fix-task.js';
import type { FailureMark, LineageProgress } from '../schemas/workflow.js';

export type ProgressStop = 'no-progress' | 'unconverged';

type FailedCheckRun = { checkId: string; status: string; failure?: { keys: readonly string[] } };

export function checkFailureMark(runs: readonly FailedCheckRun[]): FailureMark {
  return runs.map((run) => ({
    source: `check ${run.checkId}`,
    keys: run.status === 'fail' && run.failure !== undefined ? [...run.failure.keys] : [run.status],
  }));
}

/** The failure of an attempt: its failed checks, else its call outcome, else its blocked question, else its first error line. */
export function failureMark(input: {
  checks?: FailureMark;
  callOutcome?: string;
  blocked?: { question: string };
  error: string;
}): FailureMark {
  if (input.checks !== undefined && input.checks.length > 0) return input.checks;
  if (input.callOutcome !== undefined) return [{ source: `call ${input.callOutcome}`, keys: [] }];
  if (input.blocked !== undefined) return [{ source: 'blocked', keys: [input.blocked.question] }];
  const line = input.error
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '');
  return [{ source: 'error', keys: [line ?? ''] }];
}

/** Same sources, and each source's keys pair fully: a diagnostic that only moved its line is the same failure. */
export function sameFailure(a: FailureMark, b: FailureMark): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry) => {
    const other = b.find((candidate) => candidate.source === entry.source);
    if (other === undefined) return false;
    const { matched, remaining } = pairFailureKeys({ carried: entry.keys, rerun: other.keys });
    return matched.size === entry.keys.length && remaining.size === 0;
  });
}

/** Judges a planner answer before it is asked: two answers in a row that did not move the failure, or too many answers, stop the lineage. */
export function judgeProgress(
  progress: LineageProgress | undefined,
  failure: FailureMark,
): { stop: ProgressStop | null; next: LineageProgress } {
  if (progress === undefined) return { stop: null, next: { failure, unmoved: 0, answers: 1 } };
  const unmoved = sameFailure(progress.failure, failure) ? progress.unmoved + 1 : 0;
  const next = { failure, unmoved, answers: progress.answers + 1 };
  if (unmoved >= 2) return { stop: 'no-progress', next };
  if (progress.answers >= BOUNDS.answersPerBrief) return { stop: 'unconverged', next };
  return { stop: null, next };
}
