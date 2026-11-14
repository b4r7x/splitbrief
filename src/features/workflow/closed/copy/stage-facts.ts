import type { CrewSeatId } from '../../../../core/crew/identity.js';
import { formatStageLabel } from '../../../../core/phases/labels.js';
import type { TaskCompletionMethod } from '../../../../core/schemas/enums.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import { formatTime } from '../../../../utils/format/time.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { passedFractionSpans } from '../../display/build-progress/counts.js';
import type { BriefRow, BriefRowState, SummaryView } from '../view-model.js';
import type { BriefRowParts, CopyFact, CopySegment, RunRow } from './types.js';

/** A stage with nothing to state and no time on record has no row. */
export function stageRow(seat: CrewSeatId, facts: CopyFact[], time: string | undefined): RunRow[] {
  const segments =
    time === undefined ? facts : [...facts, { text: time, tone: 'textDim' as const }];
  return segments.length === 0 ? [] : [{ label: formatStageLabel(seat), seat, segments }];
}

export function planSegments(view: SummaryView): CopyFact[] {
  const { plannedBriefs, planCriteria } = view.digest;
  return [
    ...(plannedBriefs === null || plannedBriefs === 0
      ? []
      : [{ text: countNoun(plannedBriefs, 'brief'), tone: 'textDim' as const }]),
    ...(planCriteria === null
      ? []
      : [{ text: countNoun(planCriteria, 'criterion', 'criteria'), tone: 'textDim' as const }]),
  ];
}

export function buildSegments(view: SummaryView): CopyFact[] {
  const { total, passed, failed, rows } = view.briefs;
  if (total === 0) return [{ text: 'no briefs', tone: 'textDim' }];
  const consulted = rows.filter((row) => row.method === 'consulted').length;
  const escalated = rows.filter((row) => row.state === 'escalated').length;
  const skipped = rows.filter((row) => row.state === 'skipped').length;
  const retries = rows.reduce((sum, row) => sum + row.retries, 0);
  const fixBriefs = view.digest.fixBriefs;
  return [
    { spans: passedFractionSpans(`${passed}/${total} briefs`) },
    ...(failed > 0 ? [{ text: `${failed} failed`, tone: stateTone('failed') }] : []),
    ...(fixBriefs > 0 ? [{ text: `${fixBriefs} from fix cycles`, tone: 'textDim' as const }] : []),
    ...(consulted > 0 ? [{ text: `${consulted} consulted`, tone: 'textDim' as const }] : []),
    ...(escalated > 0 ? [{ text: `${escalated} escalated`, tone: stateTone('attention') }] : []),
    ...(skipped > 0 ? [{ text: `${skipped} skipped`, tone: stateTone('pending') }] : []),
    ...(retries > 0
      ? [{ text: countNoun(retries, 'retry', 'retries'), tone: 'textDim' as const }]
      : []),
  ];
}

export function criteriaSegments(view: SummaryView): CopyFact[] {
  const criteria = view.digest.criteria;
  if (view.review.kind !== 'written' || criteria === null) return [];
  return [{ text: `${criteria.passed}/${criteria.total} criteria`, tone: 'textDim' }];
}

/**
 * Each phase's time, in the whole seconds that add up to the run's own: the whole seconds of the
 * run are split by largest remainder, where flooring each phase alone would lose up to a second each.
 */
export function phaseTimes(
  phases: SummaryView['phases'],
  ran: number | null,
): Map<SummaryView['phases'][number]['phase'], string> {
  const seconds = (ms: number) => Math.floor(ms / 1000);
  const whole = seconds(ran ?? phases.reduce((sum, timing) => sum + timing.ms, 0));
  const short = whole - phases.reduce((sum, timing) => sum + seconds(timing.ms), 0);
  const roundedUp = new Set(
    phases
      .map((timing, index) => ({ index, remainder: timing.ms % 1000 }))
      .sort((left, right) => right.remainder - left.remainder)
      .slice(0, Math.max(0, short))
      .map((entry) => entry.index),
  );
  return new Map(
    phases.map((timing, index) => [
      timing.phase,
      formatTime((seconds(timing.ms) + (roundedUp.has(index) ? 1 : 0)) * 1000),
    ]),
  );
}

export function sessionSegments(run: SummaryView['run']): CopySegment[] {
  return [{ text: run.sessionId, tone: 'textDim' }];
}

type SettledBriefState = Exclude<BriefRowState, 'stopped' | 'pending'>;

/** The method a ledger-only brief implies, for rows the spend record never booked. */
const SETTLED_METHODS: Readonly<Record<SettledBriefState, TaskCompletionMethod>> = {
  local: 'local',
  escalated: 'escalated-full',
  failed: 'failed',
  skipped: 'skipped',
};

export function briefRowParts(input: Readonly<{ row: BriefRow }>): BriefRowParts {
  const { row } = input;
  const state = briefState(row);
  const note =
    state.kind === 'halted' && row.partialFiles > 0
      ? countNoun(row.partialFiles, 'partial file')
      : undefined;
  return {
    id: row.id,
    title: row.title,
    state,
    ...(row.retries > 0 && { retries: row.retries }),
    ...(row.durationMs !== null && { duration: row.durationMs }),
    ...(row.file !== null && { file: row.file }),
    ...(row.fileNote !== undefined && { fileNote: row.fileNote }),
    ...(row.extraFiles !== undefined && { extraFiles: row.extraFiles }),
    ...(note !== undefined && { note }),
  };
}

/** The brief the run was inside when it closed wears the run's own ending, in one word. */
function briefState(row: BriefRow): BriefRowParts['state'] {
  if (row.state === 'pending') return { kind: 'pending' };
  if (row.state === 'stopped') return { kind: 'halted', tone: 'cancelled', word: 'stopped' };
  return { kind: 'settled', method: row.method ?? SETTLED_METHODS[row.state] };
}
