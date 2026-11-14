import type {
  ReviewVerdict,
  SetAside,
  TriageInput,
  TriageResult,
} from '../schemas/review/verdict.js';
import type { ReviewRecord } from '../schemas/workflow/review-record.js';
import { oneLineDisplayText } from '../../utils/display-text/sanitize.js';
import { countNoun } from '../../utils/pluralize.js';
import {
  type Finding,
  type ReviewScope,
  findingInReviewScope,
  verdictCoverageErrors,
} from './scope.js';

export type ReviewOutcome = {
  kind: 'pass' | 'pass-with-notes' | 'fail';
  blocking: Finding[];
  minor: Finding[];
  outOfScope: Finding[];
  unverifiedCriteria: string[];
  coverageErrors: string[];
  criteria: ReviewVerdict['criteria'];
  redInputs: RedInput[];
};

export type RedInput = Pick<TriageInput, 'id' | 'text'>;

/** What fails a review: each blocking finding, then each red input that still blocks. */
export function blockingEntries(
  outcome: Pick<ReviewOutcome, 'blocking' | 'redInputs'>,
): { id: string; text: string }[] {
  return [...outcome.blocking, ...outcome.redInputs].map(({ id, text }) => ({ id, text }));
}

/**
 * One key per problem that fails a review, stable across reviews: a red input by its command and
 * failure keys (its id is positional), a finding by its id. Two rounds with equal keys moved nothing.
 */
export function blockingKeys(
  outcome: Pick<ReviewOutcome, 'blocking' | 'redInputs'>,
  inputs: readonly TriageInput[],
): string[] {
  const red = new Map(inputs.filter(isRedInput).map((input) => [input.id, input]));
  return blockingEntries(outcome).map(({ id }) => {
    const input = red.get(id);
    if (input === undefined) return `finding:${id}`;
    const failures = input.failureKeys ?? (input.file === null ? [] : [input.file]);
    return `${input.source}:${input.command ?? id}:${failures.join('|')}`;
  });
}

/** A failed check or Apply input; a correction or an answer from the user is never red. */
function isRedInput(input: TriageInput): boolean {
  return input.source === 'check' || input.source === 'apply';
}

/** The red inputs that still block a review: each one the answer does not reject. */
export function blockingRedInputs(
  inputs: readonly TriageInput[],
  fixWork: TriageResult,
): TriageInput[] {
  const rejected = new Set(fixWork.rejected.map((entry) => entry.findingId));
  return inputs.filter((input) => isRedInput(input) && !rejected.has(input.id));
}

/** The red inputs the answer rejects, each with the reviewer's reason. */
export function setAsideInputs(inputs: readonly TriageInput[], fixWork: TriageResult): SetAside[] {
  const red = new Set(inputs.filter(isRedInput).map((input) => input.id));
  return fixWork.rejected
    .filter((entry) => red.has(entry.findingId))
    .map((entry) => ({ id: entry.findingId, reason: entry.reason }));
}

export function setAsideLabel(id: string): string {
  return `Set aside ${id}`;
}

export function setAsideLine(entry: SetAside): string {
  return `${setAsideLabel(entry.id)}: ${oneLineDisplayText(entry.reason)}`;
}

export function verificationKey(kind: 'criterion' | 'finding', id: string): string {
  return `${kind}:${id}`;
}

export function reviewOutcomeOf(record: ReviewRecord): ReviewOutcome {
  return deriveReviewOutcome(
    record.verdict,
    {
      kind: record.scope ?? 'final',
      taskIds: record.verdict.tasks.map((task) => task.id),
      criterionIds: record.verdict.criteria.map((criterion) => criterion.id),
    },
    new Map(record.verification.map((entry) => [entry.id, entry.status])),
    record.redInputs,
  );
}

/**
 * The findings an Accept as is leaves open: each blocking finding, each criterion short of a pass,
 * each coverage error. A red input is no finding: your accept records it as a red check.
 */
export function openFindings(outcome: ReviewOutcome): string[] {
  return [
    ...outcome.blocking.map((finding) => finding.text),
    ...outcome.criteria
      .filter((criterion) => criterion.status !== 'pass')
      .map((criterion) => `Criterion ${criterion.id}: ${criterion.status} — ${criterion.evidence}`),
    ...outcome.coverageErrors,
  ];
}

export function reviewOutcomeWord(outcome: ReviewOutcome): 'pass' | 'pass_with_notes' | 'fail' {
  return outcome.kind === 'pass-with-notes' ? 'pass_with_notes' : outcome.kind;
}

export function reviewFindingCounts(outcome: ReviewOutcome) {
  return {
    critical: outcome.blocking.length + outcome.redInputs.length,
    warning: outcome.minor.length,
    note: outcome.outOfScope.length,
  };
}

type FindingCounts = Readonly<{ critical: number; warning: number; note: number }>;

/** The finding tallies of the review packet, zeros stated: a minor and an out-of-scope finding are both notes. */
export function formatFindingCounts(counts: FindingCounts): string {
  return `${counts.critical} blocking, ${countNoun(counts.warning + counts.note, 'note')}`;
}

/**
 * The findings a review left, one fact per kind and none for a kind with no finding: the closed
 * run and the transcript say `1 note`, never `0 blocking`.
 */
export function findingFacts(counts: FindingCounts): string[] {
  const notes = counts.warning + counts.note;
  return [
    ...(counts.critical > 0 ? [`${counts.critical} blocking`] : []),
    ...(notes > 0 ? [countNoun(notes, 'note')] : []),
  ];
}

export function deriveReviewOutcome(
  verdict: ReviewVerdict,
  scope: ReviewScope,
  verification: ReadonlyMap<string, 'pass' | 'fail' | 'unverified'>,
  redInputs: readonly RedInput[] = [],
): ReviewOutcome {
  const coverageErrors = verdictCoverageErrors(verdict, scope);
  const unverifiedCriteria: string[] = [];
  const criteria = verdict.criteria.map((criterion) => {
    const status =
      criterion.status === 'unverified'
        ? (verification.get(verificationKey('criterion', criterion.id)) ?? 'unverified')
        : criterion.status;
    if (status === 'unverified') unverifiedCriteria.push(criterion.id);
    return { ...criterion, status };
  });
  const blocking: Finding[] = [];
  const minor: Finding[] = [];
  const outOfScope: Finding[] = [];
  for (const finding of verdict.findings) {
    if (!findingInReviewScope(finding, scope)) {
      outOfScope.push(finding);
      continue;
    }
    const verified =
      finding.kind === 'unverified' &&
      verification.get(verificationKey('finding', finding.id)) === 'pass';
    if (finding.severity === 'blocking' && !verified) blocking.push(finding);
    else minor.push(finding);
  }
  const failed =
    coverageErrors.length > 0 ||
    unverifiedCriteria.length > 0 ||
    blocking.length > 0 ||
    redInputs.length > 0 ||
    verdict.tasks.some((task) => task.plan !== 'met') ||
    criteria.some((criterion) => criterion.status !== 'pass');
  if (failed) {
    // A blocking finding under a red input's id is that one problem: the entry whose text says more stays.
    const redText = new Map(redInputs.map((input) => [input.id, input.text]));
    const findingText = new Map(blocking.map((finding) => [finding.id, finding.text]));
    return {
      kind: 'fail',
      blocking: blocking.filter(
        (finding) => finding.text.length > (redText.get(finding.id)?.length ?? -1),
      ),
      minor,
      outOfScope,
      unverifiedCriteria,
      coverageErrors,
      criteria,
      redInputs: redInputs
        .filter((input) => input.text.length >= (findingText.get(input.id)?.length ?? 0))
        .map(({ id, text }) => ({ id, text })),
    };
  }
  return {
    kind: minor.length === 0 && outOfScope.length === 0 ? 'pass' : 'pass-with-notes',
    blocking,
    minor,
    outOfScope,
    unverifiedCriteria,
    coverageErrors,
    criteria,
    redInputs: [],
  };
}
