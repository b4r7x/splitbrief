import { SessionLogEventEntrySchema } from '../../../core/schemas/session-log.js';
import { readSessionLogValuesSync } from '../../../core/sessions/log-reader.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { isRecord } from '../../../utils/type-guards.js';
import { entryTimestamp } from '../../events/replay.js';

/** One event line of a session log, as much of it as the run's time needs. */
export type RunMark = Readonly<{
  type: string;
  ts: number;
  inProcess?: boolean;
  resumedAt?: number;
  atRestFrom?: number;
}>;

type Stretch = { start: number; latest: number; from: number };

/**
 * How long the run ran: the sum of its running stretches, in log order. A start or a resume opens a
 * stretch; a stop, a halt, a completion or a cancellation closes it. Time the run sat stopped,
 * halted or at rest is no stretch, and a wait on the user inside a stretch is part of it. A stretch
 * that a process left open, by a crash or a restart, ends at the latest mark it holds. An End
 * taken at rest (`atRestFrom`) ends it at the latest mark dated before that End began, so neither
 * the days at rest nor what the End itself writes count. Null when the log never started the run.
 */
export function activeTimeOf(marks: readonly RunMark[]): number | null {
  let total = 0;
  let started = false;
  let stretch: Stretch | null = null;
  const close = (end: (open: Stretch) => number): void => {
    if (stretch !== null) total += Math.max(0, end(stretch) - stretch.start);
    stretch = null;
  };
  marks.forEach((mark, index) => {
    switch (mark.type) {
      case 'workflow_started':
        close((open) => open.latest);
        stretch = { start: mark.ts, latest: mark.ts, from: index };
        started = true;
        return;
      case 'workflow_resumed': {
        started = true;
        if (stretch !== null && mark.inProcess === true) {
          stretch.latest = Math.max(stretch.latest, mark.ts);
          return;
        }
        close((open) => open.latest);
        const at = mark.resumedAt ?? mark.ts;
        stretch = { start: at, latest: at, from: index };
        return;
      }
      case 'turn_interrupted':
      case 'recovery_prompted':
      case 'workflow_complete':
        close(() => mark.ts);
        return;
      case 'workflow_cancelled': {
        const began = mark.atRestFrom;
        close((open) =>
          began === undefined
            ? mark.ts
            : marks
                .slice(open.from, index)
                .reduce(
                  (latest, m) => (m.ts < began ? Math.max(latest, m.ts) : latest),
                  open.start,
                ),
        );
        return;
      }
      default:
        if (stretch !== null) stretch.latest = Math.max(stretch.latest, mark.ts);
    }
  });
  close((open) => open.latest);
  return started ? total : null;
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
      ...(data.inProcess === true && { inProcess: true }),
      ...(typeof data.resumedAt === 'number' && { resumedAt: data.resumedAt }),
      ...(typeof data.atRestFrom === 'number' && { atRestFrom: data.atRestFrom }),
    });
  }
  return marks;
}
