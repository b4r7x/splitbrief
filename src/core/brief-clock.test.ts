import { describe, expect, it } from 'vitest';
import {
  type BriefClockState,
  type BriefMark,
  briefWorkedMs,
  foldBriefClock,
} from './brief-clock.js';

const at = (iso: string): number => Date.parse(iso);
const LATER = at('2026-10-20T00:00:00Z');
const mark = (type: string, iso: string, taskId?: string): BriefMark => ({
  type,
  ts: at(iso),
  ...(taskId !== undefined && { taskId }),
});

/** A stop that cut the brief mid-call, as `readBriefWorkedMs` reads its step. */
const cutOf = (taskId: string, iso: string): BriefMark => mark('turn_interrupted', iso, taskId);

/** The marks of a brief stopped mid-call after it wrote its files, then continued in a new process. */
const STOPPED_AND_CONTINUED: readonly BriefMark[] = [
  mark('workflow_started', '2026-10-15T17:05:48.351Z'),
  mark('task_started', '2026-10-15T17:06:59.904Z', 'T001'),
  mark('runner_call_started', '2026-10-15T17:07:00.475Z', 'T001'),
  mark('runner_call_usage', '2026-10-15T17:07:37.684Z', 'T001'),
  mark('runner_call_error', '2026-10-15T17:07:38.260Z', 'T001'),
  mark('turn_interrupted', '2026-10-15T17:07:38.631Z'),
  mark('warning', '2026-10-15T17:07:39.008Z'),
  mark('workflow_resumed', '2026-10-15T17:07:53.698Z'),
  mark('workflow_config', '2026-10-15T17:07:53.699Z'),
  mark('tasks_planned', '2026-10-15T17:07:53.969Z'),
];

const NO_EARLIER_STRETCH: readonly BriefMark[] = [
  mark('workflow_started', '2026-10-15T17:00:00Z'),
  mark('tasks_planned', '2026-10-15T17:01:00Z'),
];

const OTHER_BRIEFS_COMPLETION: readonly BriefMark[] = [
  mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
  mark('task_completed', '2026-10-15T17:02:00Z', 'T001'),
];

const STOPPED_TWICE: readonly BriefMark[] = [
  mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
  mark('turn_interrupted', '2026-10-15T17:00:10Z'),
  mark('workflow_resumed', '2026-10-15T18:00:00Z'),
  mark('task_started', '2026-10-15T18:00:01Z', 'T001'),
  mark('turn_interrupted', '2026-10-15T18:00:21Z'),
];

const HALTED: readonly BriefMark[] = [
  mark('task_started', '2026-10-15T12:00:00Z', 'T001'),
  mark('recovery_prompted', '2026-10-15T12:00:42Z'),
  mark('recovery_resolved', '2026-10-15T17:00:00Z'),
  mark('workflow_resumed', '2026-10-15T17:00:01Z'),
];

const CRASHED: readonly BriefMark[] = [
  mark('task_started', '2026-10-12T09:00:00Z', 'T001'),
  mark('runner_call_usage', '2026-10-12T09:00:20Z', 'T001'),
  mark('runner_call_error', '2026-10-12T09:00:05Z', 'T001'),
  mark('workflow_resumed', '2026-10-15T09:00:00Z'),
];

const OPEN_AT_LOG_END: readonly BriefMark[] = [
  mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
  mark('consult_requested', '2026-10-15T17:00:07Z', 'T001'),
];
const OPEN_AT_LOG_END_NOW = at('2026-10-15T17:00:30Z');

const STEER_CONTINUED: readonly BriefMark[] = [
  mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
  mark('runner_call_started', '2026-10-15T17:00:01Z', 'T001'),
  cutOf('T001', '2026-10-15T17:00:10Z'),
  mark('runner_call_started', '2026-10-15T17:00:12Z', 'T001'),
  mark('runner_call_usage', '2026-10-15T17:01:00Z', 'T001'),
  cutOf('T001', '2026-10-15T17:01:12Z'),
  mark('workflow_resumed', '2026-10-16T09:00:00Z'),
  mark('task_started', '2026-10-16T09:00:01Z', 'T001'),
];
const STEER_CONTINUED_NOW = at('2026-10-16T09:00:21Z');

const WATCHDOG_PARK: readonly BriefMark[] = [
  mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
  cutOf('T001', '2026-10-15T17:05:00Z'),
  mark('warning', '2026-10-15T17:05:01Z'),
  mark('runner_call_started', '2026-10-15T19:00:00Z', 'T001'),
];
const WATCHDOG_PARK_NOW = at('2026-10-15T19:00:40Z');

const CUT_SETTLED_BY_ANOTHER_BRIEF: readonly BriefMark[] = [
  mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
  cutOf('T001', '2026-10-15T17:00:10Z'),
  mark('recovery_prompted', '2026-10-15T17:00:11Z'),
  mark('runner_call_started', '2026-10-15T18:00:00Z', 'T001'),
];

const CUT_SETTLED_BY_A_HALT: readonly BriefMark[] = [
  mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
  mark('turn_interrupted', '2026-10-15T17:00:10Z'),
  mark('runner_call_started', '2026-10-15T18:00:00Z', 'T001'),
];

const REDO: readonly BriefMark[] = [
  mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
  mark('recovery_prompted', '2026-10-15T17:00:10Z'),
  mark('task_reset', '2026-10-15T17:05:00Z', 'T001'),
  mark('task_started', '2026-10-15T17:05:01Z', 'T001'),
  mark('turn_interrupted', '2026-10-15T17:05:06Z'),
];

const REDO_AFTER_END: readonly BriefMark[] = [
  ...REDO,
  mark('task_started', '2026-10-15T17:06:00Z', 'T001'),
  mark('task_completed', '2026-10-15T17:06:30Z', 'T001'),
];

const ANOTHER_BRIEF_STOPPED: readonly BriefMark[] = [
  mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
  mark('task_completed', '2026-10-15T17:00:30Z', 'T001'),
  mark('task_started', '2026-10-15T17:00:31Z', 'T002'),
  mark('turn_interrupted', '2026-10-15T17:01:31Z'),
  mark('workflow_resumed', '2026-10-15T17:30:00Z'),
];

describe('briefWorkedMs', () => {
  it('counts the stretch a stopped brief worked, not the time it sat stopped', () => {
    expect(briefWorkedMs(STOPPED_AND_CONTINUED, 'T001', LATER)).toBe(38_727);
  });

  it('is 0 for a brief with no earlier stretch', () => {
    expect(briefWorkedMs(NO_EARLIER_STRETCH, 'T001', LATER)).toBe(0);
    expect(briefWorkedMs(OTHER_BRIEFS_COMPLETION, 'T002', LATER)).toBe(0);
  });

  it('adds every stretch of a brief stopped twice', () => {
    expect(briefWorkedMs(STOPPED_TWICE, 'T001', LATER)).toBe(30_000);
  });

  it('ends a stretch at the halt, not at the answer hours later', () => {
    expect(briefWorkedMs(HALTED, 'T001', LATER)).toBe(42_000);
  });

  it('ends a crashed stretch at its latest mark, the cut call the restart records included', () => {
    expect(briefWorkedMs(CRASHED, 'T001', LATER)).toBe(20_000);
  });

  it('runs the stretch still open at the end of the log to now', () => {
    expect(briefWorkedMs(OPEN_AT_LOG_END, 'T001', OPEN_AT_LOG_END_NOW)).toBe(30_000);
  });

  it('counts the stretch a steer continued in process before a stop and a Continue', () => {
    expect(briefWorkedMs(STEER_CONTINUED, 'T001', STEER_CONTINUED_NOW)).toBe(
      10_000 + 60_000 + 20_000,
    );
  });

  it('leaves out the time a watchdog park waited for /resume', () => {
    expect(briefWorkedMs(WATCHDOG_PARK, 'T001', WATCHDOG_PARK_NOW)).toBe(300_000 + 40_000);
  });

  it('opens no stretch for a cut that another brief or a halt settled', () => {
    expect(briefWorkedMs(CUT_SETTLED_BY_ANOTHER_BRIEF, 'T001', LATER)).toBe(10_000);
    expect(briefWorkedMs(CUT_SETTLED_BY_A_HALT, 'T001', LATER)).toBe(10_000);
  });

  it('keeps counting across a redo, and starts again after the brief ended', () => {
    expect(briefWorkedMs(REDO, 'T001', LATER)).toBe(15_000);
    expect(briefWorkedMs(REDO_AFTER_END, 'T001', LATER)).toBe(0);
  });

  it('does not count another brief stopped and continued', () => {
    expect(briefWorkedMs(ANOTHER_BRIEF_STOPPED, 'T001', LATER)).toBe(0);
  });
});

describe('foldBriefClock', () => {
  it('returns the same clock for a mark that changes nothing', () => {
    const running: BriefClockState = {
      taskId: 'T001',
      workedMs: 5_000,
      stretch: { start: 10_000, latest: 20_000 },
      cut: false,
    };
    const stopped: BriefClockState = { taskId: 'T001', workedMs: 5_000, stretch: null, cut: true };

    expect(
      foldBriefClock(running, { type: 'runner_call_activity', ts: 20_000, taskId: 'T001' }),
    ).toBe(running);
    expect(foldBriefClock(stopped, { type: 'warning', ts: 30_000 })).toBe(stopped);
  });
});
