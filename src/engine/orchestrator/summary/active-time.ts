import { phaseStage } from '../../../core/rail-stages.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { SessionLogEventEntrySchema } from '../../../core/schemas/session-log.js';
import { readSessionLogValuesSync } from '../../../core/sessions/log-reader.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { isRecord } from '../../../utils/type-guards.js';
import { entryTimestamp } from '../../events/replay.js';

/** One event line of a session log, as much of it as the run's time needs. */
export type RunMark = Readonly<{
  type: string;
  ts: number;
  phase?: Phase;
  inProcess?: boolean;
  resumedAt?: number;
  atRestFrom?: number;
}>;

type Stretch = { start: number; latest: number; from: number };

/** A closed running stretch: its time span, and the marks inside it, `from` up to `to` exclusive. */
type RunStretch = Readonly<{ start: number; end: number; from: number; to: number }>;

const RUN_STARTS_AND_STOPS = new Set([
  'workflow_started',
  'workflow_resumed',
  'turn_interrupted',
  'recovery_prompted',
  'workflow_complete',
  'workflow_cancelled',
]);

/**
 * The run's running stretches, in log order. A start or a resume opens a
 * stretch; a stop, a halt, a completion or a cancellation closes it. A resume in phase `complete`,
 * after Accept as is or for an Apply, opens none: no seat runs there, so the ready menu and the
 * Apply are no run time. When that Apply sends the run back to review, the first mark in a phase
 * of a stage opens a stretch again. A stop that the same process
 * continued, by a steer, a ctrl+⏎ send or a Resume of the cut call, opens a stretch again at the
 * next call. Time the run sat stopped, halted or at rest is no stretch, and a wait on the user
 * inside a stretch is part of it. A stretch that a process left open, by a crash or a restart, ends
 * at the latest mark it holds. An End taken at rest (`atRestFrom`) ends it at the latest mark dated
 * before that End began, so neither the days at rest nor what the End itself writes count. Null
 * when the log never started the run.
 */
function runStretches(marks: readonly RunMark[]): RunStretch[] | null {
  const stretches: RunStretch[] = [];
  let started = false;
  let stretch: Stretch | null = null;
  let reopen: 'at-call' | 'at-stage' | null = null;
  const close = (end: (open: Stretch) => number, to: number): void => {
    if (stretch !== null) {
      stretches.push({ start: stretch.start, end: end(stretch), from: stretch.from, to });
    }
    stretch = null;
  };
  marks.forEach((mark, index) => {
    if (RUN_STARTS_AND_STOPS.has(mark.type)) reopen = null;
    switch (mark.type) {
      case 'workflow_started':
        close((open) => open.latest, index);
        stretch = { start: mark.ts, latest: mark.ts, from: index };
        started = true;
        return;
      case 'workflow_resumed': {
        started = true;
        if (mark.phase === 'complete') {
          close((open) => open.latest, index);
          reopen = 'at-stage';
          return;
        }
        if (stretch !== null && mark.inProcess === true) {
          stretch.latest = Math.max(stretch.latest, mark.ts);
          return;
        }
        close((open) => open.latest, index);
        const at = mark.resumedAt ?? mark.ts;
        stretch = { start: at, latest: at, from: index };
        return;
      }
      case 'turn_interrupted':
        close(() => mark.ts, index);
        reopen = 'at-call';
        return;
      case 'recovery_prompted':
      case 'workflow_complete':
        close(() => mark.ts, index);
        return;
      case 'workflow_cancelled': {
        const began = mark.atRestFrom;
        close(
          (open) =>
            began === undefined
              ? mark.ts
              : marks
                  .slice(open.from, index)
                  .reduce(
                    (latest, m) => (m.ts < began ? Math.max(latest, m.ts) : latest),
                    open.start,
                  ),
          index,
        );
        return;
      }
      default:
        if (
          reopen === 'at-call'
            ? mark.type === 'runner_call_started'
            : reopen === 'at-stage' && mark.phase !== undefined && phaseStage(mark.phase) !== null
        ) {
          stretch = { start: mark.ts, latest: mark.ts, from: index };
          reopen = null;
          return;
        }
        if (stretch !== null) stretch.latest = Math.max(stretch.latest, mark.ts);
    }
  });
  close((open) => open.latest, marks.length);
  return started ? stretches : null;
}

/** How long the run ran: the sum of its running stretches. Null when the log never started the run. */
export function activeTimeOf(marks: readonly RunMark[]): number | null {
  const stretches = runStretches(marks);
  if (stretches === null) return null;
  return stretches.reduce((total, s) => total + Math.max(0, s.end - s.start), 0);
}

const PHASE_TIME_KEYS = { plan: 'planning', build: 'implementing', review: 'review' } as const;

/**
 * How long the run ran in each stage, keyed `planning`, `implementing` and `review`, over the same
 * stretches as {@link activeTimeOf}. Each mark splits its stretch, and the piece up to the next mark
 * counts for the stage of the phase the mark was written in. A mark that names no phase, as an
 * old log line can, keeps the phase of the mark before it. Null when the log never started the run.
 */
export function phaseTimesOf(marks: readonly RunMark[]): Record<string, number> | null {
  const stretches = runStretches(marks);
  if (stretches === null) return null;
  let phase: Phase | undefined;
  const phases = marks.map((mark) => {
    phase = mark.phase ?? phase;
    return phase;
  });
  const times: Record<string, number> = {};
  for (const { start, end, from, to } of stretches) {
    let cursor = start;
    for (let index = from; index < to && cursor < end; index++) {
      const next =
        index + 1 < to ? Math.min(end, Math.max(cursor, marks[index + 1]?.ts ?? end)) : end;
      const marked = phases[index];
      const stage = marked === undefined ? null : phaseStage(marked);
      if (stage !== null) {
        const key = PHASE_TIME_KEYS[stage];
        times[key] = (times[key] ?? 0) + next - cursor;
      }
      cursor = next;
    }
  }
  return times;
}

/**
 * The marks of every event line in the session log. An old line that today's event schema refuses
 * still marks the run's time, so only the log entry shape is read. Null when there is no log.
 */
export function readRunMarks(ref: SessionRef): RunMark[] | null {
  const values = readSessionLogValuesSync(ref, (line) => line.includes('"kind":"event"'));
  if (values === null) return null;
  const marks: RunMark[] = [];
  for (const value of values) {
    const entry = SessionLogEventEntrySchema.safeParse(value);
    if (!entry.success) continue;
    const ts = entryTimestamp(entry.data.ts);
    if (ts === null) continue;
    const data = isRecord(entry.data.data) ? entry.data.data : {};
    marks.push({
      type: entry.data.type,
      ts,
      ...(entry.data.phase !== undefined && { phase: entry.data.phase }),
      ...(data.inProcess === true && { inProcess: true }),
      ...(typeof data.resumedAt === 'number' && { resumedAt: data.resumedAt }),
      ...(typeof data.atRestFrom === 'number' && { atRestFrom: data.atRestFrom }),
    });
  }
  return marks;
}
