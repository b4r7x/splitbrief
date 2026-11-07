/**
 * One event line of a session log, as much of it as a brief's time needs. `taskId` names the brief
 * the mark belongs to; a stop that cut a brief mid-call belongs to that brief.
 */
export type BriefMark = Readonly<{ type: string; ts: number; taskId?: string }>;

export type BriefMarkId = Readonly<{
  taskId?: string | undefined;
  at?: string | undefined;
  step?: Readonly<{ kind: string; taskId?: string | undefined }> | undefined;
}>;

export type BriefClockState = Readonly<{
  taskId: string;
  workedMs: number;
  stretch: Readonly<{ start: number; latest: number }> | null;
  cut: boolean;
}>;

const BRIEF_ENDS = new Set(['task_completed', 'task_skipped', 'task_full_fail']);
const RUN_STOPS = new Set([
  'turn_interrupted',
  'recovery_prompted',
  'workflow_cancelled',
  'workflow_complete',
]);
const RUN_STARTS = new Set(['workflow_started', 'workflow_resumed']);

export function briefMarkTaskId(mark: BriefMarkId): string | undefined {
  if (mark.taskId !== undefined) return mark.taskId;
  return mark.at === 'mid-step' && mark.step?.kind === 'brief' ? mark.step.taskId : undefined;
}

export function endsBriefClock(clock: BriefClockState, mark: BriefMark): boolean {
  return mark.taskId === clock.taskId && BRIEF_ENDS.has(mark.type);
}

export function foldBriefClock(clock: BriefClockState, mark: BriefMark): BriefClockState {
  const own = mark.taskId === clock.taskId;
  if (endsBriefClock(clock, mark)) {
    return { taskId: clock.taskId, workedMs: 0, stretch: null, cut: false };
  }
  let { workedMs, stretch, cut } = clock;
  if (stretch !== null) {
    if (RUN_STOPS.has(mark.type)) {
      workedMs += Math.max(0, mark.ts - stretch.start);
      stretch = null;
      cut = own && mark.type === 'turn_interrupted';
    } else if (RUN_STARTS.has(mark.type) || mark.type === 'task_started') {
      workedMs += Math.max(0, stretch.latest - stretch.start);
      stretch = null;
    } else if (mark.ts > stretch.latest) {
      stretch = { start: stretch.start, latest: mark.ts };
    }
  } else if (RUN_STARTS.has(mark.type) || RUN_STOPS.has(mark.type)) {
    cut = false;
  } else if (cut && mark.type === 'runner_call_started') {
    if (own) stretch = { start: mark.ts, latest: mark.ts };
    cut = false;
  }
  if (own && mark.type === 'task_started') {
    stretch = { start: mark.ts, latest: mark.ts };
    cut = false;
  }
  if (workedMs === clock.workedMs && stretch === clock.stretch && cut === clock.cut) return clock;
  return { taskId: clock.taskId, workedMs, stretch, cut };
}

export function briefClockMs(clock: BriefClockState, now: number): number {
  const running = clock.stretch === null ? 0 : Math.max(0, now - clock.stretch.start);
  return clock.workedMs + running;
}

/**
 * The time a brief has worked by `now`, in log order. Its `task_started` opens a stretch; a stop, a
 * halt, a cancellation or a completion of the run closes it at that mark. A stop that cut the brief
 * mid-call and that the same process continued, by a steer, a `/resume` or a watchdog park, opens a
 * stretch again at the brief's next call: the rule `readUnresumedBriefCut` applies to a cut. A
 * stretch that a process left open, by a crash or a restart, ends at the latest mark it holds. The
 * stretch still open at the end of the log is the one running, and it runs to `now`. The time the
 * run sat stopped, parked or halted is no stretch. An end of the brief starts its count again.
 */
export function briefWorkedMs(marks: readonly BriefMark[], taskId: string, now: number): number {
  const clock = marks.reduce<BriefClockState>(foldBriefClock, {
    taskId,
    workedMs: 0,
    stretch: null,
    cut: false,
  });
  return briefClockMs(clock, now);
}
