import { oneLineDisplayText } from '../../utils/display-text/sanitize.js';
import { truncateByChars } from '../../utils/display-text/truncate.js';
import { countNoun } from '../../utils/pluralize.js';
import type { TriageResult, TriageInput } from '../schemas/review/verdict.js';
import type { RedCheck, ReviewRecord } from '../schemas/workflow/review-record.js';
import type { WorkflowState } from '../schemas/workflow/state.js';
import { SOFT_SEP } from '../separators.js';
import { blockingRedInputs, reviewOutcomeOf, openFindings } from './verdict.js';

/**
 * The reviewer's recorded answer to the review at `reviewAt`. An answer that fixes, rejects and
 * asks nothing records none.
 */
export function recordedFixWork(state: WorkflowState, reviewAt: string | undefined): TriageResult {
  return (
    state.triage?.findLast((record) => record.reviewAt === reviewAt)?.result ?? {
      fixTasks: [],
      rejected: [],
      ask: null,
    }
  );
}

const RED_CHECK_LINE_CHARS = 300;

/** The last line of a check's output that shows text, on one row and cut; none when it printed nothing. */
function lastOutputLine(output: string | undefined): string | undefined {
  for (const raw of (output ?? '').split('\n').reverse()) {
    const line = oneLineDisplayText(raw);
    if (line !== '') return truncateByChars(line, RED_CHECK_LINE_CHARS);
  }
  return undefined;
}

/**
 * The red checks behind `inputs`, once per check and in the order of the inputs: the check's id,
 * else the input's own id, with the command and the last output line of its first input.
 */
export function redChecksOf(inputs: readonly TriageInput[]): RedCheck[] {
  const redChecks = new Map<string, RedCheck>();
  for (const input of inputs) {
    const id = input.checkIds?.[0] ?? input.id;
    if (redChecks.has(id)) continue;
    const lastLine = lastOutputLine(input.output);
    redChecks.set(id, {
      id,
      ...(input.command !== undefined && { command: input.command }),
      ...(lastLine !== undefined && { lastLine }),
    });
  }
  return [...redChecks.values()];
}

/**
 * What your Accept as is leaves open: each red check that still blocks `review`, once per check,
 * then the open findings. A finding under a red input's id is that check, so it is no finding here.
 */
export function acceptedOpen(
  review: ReviewRecord,
  state: WorkflowState,
): { findings: string[]; redChecks: RedCheck[] } {
  const red = blockingRedInputs(
    state.pendingTriage?.inputs ?? [],
    recordedFixWork(state, review.at),
  );
  const redIds = new Set(red.map((input) => input.id));
  const outcome = reviewOutcomeOf(review);
  return {
    findings: openFindings({
      ...outcome,
      blocking: outcome.blocking.filter((finding) => !redIds.has(finding.id)),
    }),
    redChecks: redChecksOf(red),
  };
}

/** One red check on one line, without the part it lacks: `V1 failed · <command> · <last output line>`. */
export function redCheckLine(check: RedCheck): string {
  return [
    `${check.id} failed`,
    ...(check.command === undefined ? [] : [check.command]),
    ...(check.lastLine === undefined ? [] : [check.lastLine]),
  ].join(SOFT_SEP);
}

/**
 * The count words of an Accept as is, the red checks first: the one home of `red check` and
 * `open finding`. A zero is said only for the findings of an accept with no red check.
 */
export function acceptedCounts(
  accepted: Readonly<{
    redChecks?: readonly RedCheck[] | undefined;
    findings?: readonly string[] | undefined;
  }>,
): Readonly<{
  /** `1 red check and 2 open findings`: the counts inside a title or a sentence. */
  phrase: string;
  /** `1 red check · 2 open findings`: the counts as one fact of a status row. */
  fact: string;
  /** `1 red check`: the red checks alone; none with no red check. */
  redChecks: string | undefined;
  /** `1 red check: V1`: the red checks alone, by id; none with no red check. */
  redCheckIds: string | undefined;
}> {
  const red = accepted.redChecks ?? [];
  const findings = accepted.findings?.length ?? 0;
  const redChecks = red.length === 0 ? undefined : countNoun(red.length, 'red check');
  const counts = [
    ...(redChecks === undefined ? [] : [redChecks]),
    ...(redChecks === undefined || findings > 0 ? [countNoun(findings, 'open finding')] : []),
  ];
  return {
    phrase: counts.join(' and '),
    fact: counts.join(SOFT_SEP),
    redChecks,
    redCheckIds:
      redChecks === undefined
        ? undefined
        : `${redChecks}: ${red.map((check) => [check.id, check.command ?? check.lastLine].filter(Boolean).join(SOFT_SEP)).join(', ')}`,
  };
}

/** The note an Accept as is carries, on one line and named by who accepted: the planner, else you. */
export function acceptedNote(
  accepted: Readonly<{ note?: string | undefined; by?: 'planner' | undefined }>,
): string | undefined {
  if (accepted.note === undefined) return undefined;
  const owner = accepted.by === 'planner' ? "Planner's note" : 'Your note';
  return `${owner}: ${oneLineDisplayText(accepted.note)}`;
}

/**
 * An Accept as is in one sentence, then its note: the counts, each red check line and each open
 * finding, each on one row. The one home of `Run accepted as is with`.
 */
export function acceptedSentence(accepted: NonNullable<WorkflowState['acceptedAsIs']>): string {
  const open = [...(accepted.redChecks ?? []).map(redCheckLine), ...accepted.findings].map(
    oneLineDisplayText,
  );
  const note = acceptedNote(accepted);
  const clause = (text: string): string => text.replace(/\.$/, '');
  const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);
  return `Run accepted as is with ${acceptedCounts(accepted).phrase}: ${sentence(open.map(clause).join('; '))}${note === undefined ? '' : ` ${sentence(note)}`}`;
}
