import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { activeTimeOf, phaseTimesOf, readRunMarks, type RunMark } from './active-time.js';

const at = (iso: string): number => Date.parse(iso);
const mark = (type: string, iso: string, extra: Partial<RunMark> = {}): RunMark => ({
  type,
  ts: at(iso),
  ...extra,
});
const MIN = 60_000;

describe('activeTimeOf', () => {
  // The B1b run: two stops, two Continues and a plan card wait. The old header read 1:08, 2:29,
  // 3:01 and 1:50 for this one run.
  it('adds the running stretches of a run stopped and continued twice', () => {
    const marks = [
      mark('workflow_started', '2026-10-15T14:58:11.732Z'),
      mark('plan_ready', '2026-10-15T14:58:40.000Z'),
      mark('plan_approved', '2026-10-15T14:58:55.000Z'),
      mark('turn_interrupted', '2026-10-15T14:59:20.380Z'),
      mark('warning', '2026-10-15T14:59:20.834Z'),
      mark('workflow_resumed', '2026-10-15T15:00:30.333Z'),
      mark('turn_interrupted', '2026-10-15T15:00:41.267Z'),
      mark('workflow_resumed', '2026-10-15T15:01:04.718Z'),
      mark('workflow_complete', '2026-10-15T15:01:36.639Z'),
      mark('workspace_closed', '2026-10-15T15:03:36.274Z'),
    ];

    expect(activeTimeOf(marks)).toBe(111_503);
  });

  it('leaves out the hours a halt sat at rest before it was reopened and continued', () => {
    const marks = [
      mark('workflow_started', '2026-09-14T09:41:00.000Z'),
      mark('task_started', '2026-09-14T09:42:06.000Z'),
      mark('recovery_prompted', '2026-09-14T09:42:31.010Z'),
      mark('recovery_prompted', '2026-09-14T14:42:31.010Z'),
      mark('recovery_action_selected', '2026-09-14T14:42:40.000Z'),
      mark('recovery_resolved', '2026-09-14T14:42:41.000Z'),
      mark('workflow_resumed', '2026-09-14T14:42:42.000Z'),
      mark('task_started', '2026-09-14T14:42:43.000Z'),
      mark('workflow_complete', '2026-09-14T14:44:42.000Z'),
    ];

    expect(activeTimeOf(marks)).toBe(91_010 + 2 * MIN);
  });

  it('counts an automatic seat switch from its in-process resume', () => {
    const marks = [
      mark('workflow_started', '2026-10-13T07:34:23.341Z'),
      mark('runner_call_started', '2026-10-13T07:34:53.840Z'),
      mark('runner_call_error', '2026-10-13T07:34:56.417Z'),
      mark('recovery_prompted', '2026-10-13T07:34:56.555Z'),
      mark('seat_switched', '2026-10-13T07:35:02.092Z'),
      mark('workflow_resumed', '2026-10-13T07:35:02.222Z', { inProcess: true }),
      mark('runner_call_started', '2026-10-13T07:35:03.821Z'),
      mark('workflow_complete', '2026-10-13T07:35:39.765Z'),
    ];

    expect(activeTimeOf(marks)).toBe(33_214 + 37_543);
  });

  // The RC6 run C shape: a ctrl+⏎ interrupt-and-send cuts the call and the run goes on at once.
  it('counts the time after an interrupt-and-send continues the cut call', () => {
    const marks = [
      mark('workflow_started', '2026-10-16T21:40:00.000Z'),
      mark('runner_call_started', '2026-10-16T21:40:05.000Z'),
      mark('turn_interrupted', '2026-10-16T21:41:20.000Z'),
      mark('user_message', '2026-10-16T21:41:20.044Z'),
      mark('runner_call_started', '2026-10-16T21:41:20.700Z'),
      mark('workflow_complete', '2026-10-16T21:42:41.100Z'),
    ];

    expect(activeTimeOf(marks)).toBe(80_000 + 80_400);
  });

  it('leaves out the wait between a cut and the call the same process sent after it', () => {
    const marks = [
      mark('workflow_started', '2026-10-16T21:40:00.000Z'),
      mark('runner_call_started', '2026-10-16T21:40:05.000Z'),
      mark('turn_interrupted', '2026-10-16T21:41:00.000Z'),
      mark('warning', '2026-10-16T21:41:00.400Z'),
      mark('user_message', '2026-10-16T21:51:00.000Z'),
      mark('runner_call_started', '2026-10-16T21:51:01.000Z'),
      mark('workflow_complete', '2026-10-16T21:52:01.000Z'),
    ];

    expect(activeTimeOf(marks)).toBe(MIN + MIN);
  });

  it('opens no stretch at a call after a cut that a new process continued', () => {
    const marks = [
      mark('workflow_started', '2026-10-16T21:40:00.000Z'),
      mark('turn_interrupted', '2026-10-16T21:41:00.000Z'),
      mark('workflow_resumed', '2026-10-17T09:00:00.000Z'),
      mark('runner_call_started', '2026-10-17T09:00:01.000Z'),
      mark('workflow_complete', '2026-10-17T09:01:00.000Z'),
    ];

    expect(activeTimeOf(marks)).toBe(MIN + MIN);
  });

  it('opens a stretch at the submit time of a continued boundary park', () => {
    const marks = [
      mark('workflow_started', '2026-10-15T10:00:00.000Z'),
      mark('turn_interrupted', '2026-10-15T10:01:00.000Z'),
      mark('workflow_resumed', '2026-10-15T10:30:00.500Z', {
        inProcess: true,
        resumedAt: at('2026-10-15T10:30:00.000Z'),
      }),
      mark('workflow_complete', '2026-10-15T10:31:00.000Z'),
    ];

    expect(activeTimeOf(marks)).toBe(2 * MIN);
  });

  it('keeps one stretch open through an in-process resume that no stop preceded', () => {
    const marks = [
      mark('workflow_started', '2026-10-15T10:00:00.000Z'),
      mark('workflow_resumed', '2026-10-15T10:01:00.000Z', { inProcess: true }),
      mark('workflow_complete', '2026-10-15T10:02:00.000Z'),
    ];

    expect(activeTimeOf(marks)).toBe(2 * MIN);
  });

  it('ends a crashed process at its last mark when the run is ended at rest days later', () => {
    const endBegan = at('2026-10-13T10:05:00.000Z');
    const marks = [
      mark('workflow_started', '2026-10-10T10:00:00.000Z'),
      mark('runner_call_started', '2026-10-10T10:04:00.000Z'),
      // The End's own writes: the cut call, dated at its last report, then the close notices.
      mark('runner_call_error', '2026-10-10T10:05:00.000Z'),
      mark('warning', '2026-10-13T10:05:00.010Z'),
      mark('workspace_closed', '2026-10-13T10:05:00.020Z'),
      mark('workflow_cancelled', '2026-10-13T10:05:00.030Z', { atRestFrom: endBegan }),
    ];

    expect(activeTimeOf(marks)).toBe(5 * MIN);
  });

  it('counts a wait on the user up to a live End', () => {
    const marks = [
      mark('workflow_started', '2026-10-15T10:00:00.000Z'),
      mark('plan_ready', '2026-10-15T10:01:00.000Z'),
      mark('workflow_cancelled', '2026-10-15T10:11:00.000Z'),
    ];

    expect(activeTimeOf(marks)).toBe(11 * MIN);
  });

  it('ends a crashed process at its latest mark when a restart resumes it', () => {
    const marks = [
      mark('workflow_started', '2026-10-10T10:00:00.000Z'),
      mark('task_started', '2026-10-10T10:05:00.000Z'),
      mark('workflow_resumed', '2026-10-11T09:00:00.000Z'),
      // The cut call of the crashed process, appended after the restart with its own old time.
      mark('runner_call_error', '2026-10-10T10:06:00.000Z'),
      mark('workflow_complete', '2026-10-11T09:01:00.000Z'),
    ];

    expect(activeTimeOf(marks)).toBe(6 * MIN);
  });

  it('counts a run that started and stopped at once as no time, and a run never started as null', () => {
    expect(
      activeTimeOf([
        mark('workflow_started', '2026-10-15T10:00:00.000Z'),
        mark('turn_interrupted', '2026-10-15T10:00:00.000Z'),
      ]),
    ).toBe(0);
    expect(activeTimeOf([mark('warning', '2026-10-15T10:00:00.000Z')])).toBeNull();
    expect(activeTimeOf([])).toBeNull();
  });
});

describe('phaseTimesOf', () => {
  // The run S shape: planning, a stop inside the brief, a Continue in a new process, the review.
  it('adds each phase across a stop and a Continue that picks up at the brief', () => {
    const marks = [
      mark('workflow_started', '2026-10-19T14:00:00.000Z', { phase: 'planning' }),
      mark('tasks_planned', '2026-10-19T14:00:25.000Z', { phase: 'reviewing-plan' }),
      mark('plan_approved', '2026-10-19T14:00:30.000Z', { phase: 'reviewing-plan' }),
      mark('task_started', '2026-10-19T14:00:31.000Z', { phase: 'implementing' }),
      mark('turn_interrupted', '2026-10-19T14:00:51.000Z', { phase: 'implementing' }),
      mark('workflow_resumed', '2026-10-19T15:00:00.000Z', { phase: 'implementing' }),
      mark('task_started', '2026-10-19T15:00:01.000Z', { phase: 'implementing' }),
      mark('task_validating', '2026-10-19T15:00:40.000Z', { phase: 'validating-task' }),
      mark('task_completed', '2026-10-19T15:00:45.000Z', { phase: 'implementing' }),
      mark('review_started', '2026-10-19T15:00:46.000Z', { phase: 'final-review' }),
      mark('workflow_complete', '2026-10-19T15:01:06.000Z', { phase: 'complete' }),
      mark('snapshot_created', '2026-10-19T15:01:07.000Z', { phase: 'complete' }),
    ];

    expect(phaseTimesOf(marks)).toEqual({ planning: 31_000, implementing: 66_000, review: 20_000 });
    expect(activeTimeOf(marks)).toBe(31_000 + 66_000 + 20_000);
  });

  // The run N shape: a halt before the final review, answered minutes later in the same process.
  it('adds each phase across a halt that the same process continued', () => {
    const marks = [
      mark('workflow_started', '2026-10-19T14:19:25.000Z', { phase: 'planning' }),
      mark('plan_approved', '2026-10-19T14:21:23.000Z', { phase: 'reviewing-plan' }),
      mark('task_started', '2026-10-19T14:21:24.000Z', { phase: 'implementing' }),
      mark('review_started', '2026-10-19T14:21:56.000Z', { phase: 'implementing' }),
      mark('task_started', '2026-10-19T14:22:13.000Z', { phase: 'implementing' }),
      mark('recovery_prompted', '2026-10-19T14:22:55.000Z', { phase: 'final-review' }),
      mark('recovery_resolved', '2026-10-19T14:24:24.000Z', { phase: 'final-review' }),
      mark('workflow_resumed', '2026-10-19T14:24:29.000Z', {
        phase: 'final-review',
        inProcess: true,
      }),
      mark('review_started', '2026-10-19T14:24:30.000Z', { phase: 'final-review' }),
      mark('workflow_complete', '2026-10-19T14:24:56.000Z', { phase: 'complete' }),
    ];

    expect(phaseTimesOf(marks)).toEqual({
      planning: 119_000,
      implementing: 91_000,
      review: 27_000,
    });
  });

  // The LR7 run1 shape: Accept as is at a final-review halt, then Apply from the ready menu.
  it('counts neither the ready menu nor the Apply after Accept as is', () => {
    const marks = [
      mark('workflow_started', '2026-10-19T14:25:00.000Z', { phase: 'planning' }),
      mark('task_started', '2026-10-19T14:25:46.000Z', { phase: 'implementing' }),
      mark('review_started', '2026-10-19T14:39:30.000Z', { phase: 'final-review' }),
      mark('recovery_prompted', '2026-10-19T14:41:59.747Z', { phase: 'final-review' }),
      mark('recovery_action_selected', '2026-10-19T14:46:30.512Z', { phase: 'final-review' }),
      mark('recovery_resolved', '2026-10-19T14:46:30.602Z', { phase: 'complete' }),
      mark('workflow_resumed', '2026-10-19T14:46:34.475Z', { phase: 'complete', inProcess: true }),
      mark('workflow_config', '2026-10-19T14:46:34.480Z', { phase: 'complete' }),
      mark('warning', '2026-10-19T14:46:35.729Z', { phase: 'complete' }),
      mark('workspace_closed', '2026-10-19T14:48:01.272Z', { phase: 'complete' }),
    ];

    expect(phaseTimesOf(marks)).toEqual({
      planning: 46_000,
      implementing: 824_000,
      review: 149_747,
    });
    expect(activeTimeOf(marks)).toBe(46_000 + 824_000 + 149_747);
  });

  // The LR5 c25 shape: an Apply in a new process halts part way and runs again in the same process.
  it('counts no Apply that a new process runs on a ready run, nor its retry', () => {
    const marks = [
      mark('workflow_started', '2026-10-18T18:26:09.000Z', { phase: 'planning' }),
      mark('task_started', '2026-10-18T18:27:00.000Z', { phase: 'implementing' }),
      mark('review_started', '2026-10-18T18:39:36.000Z', { phase: 'final-review' }),
      mark('workflow_complete', '2026-10-18T18:40:06.000Z', { phase: 'complete' }),
      mark('workflow_resumed', '2026-10-18T18:40:44.415Z', { phase: 'complete' }),
      mark('recovery_prompted', '2026-10-18T18:40:44.481Z', { phase: 'complete' }),
      mark('workflow_resumed', '2026-10-18T18:40:55.795Z', { phase: 'complete', inProcess: true }),
      mark('error', '2026-10-18T18:41:17.731Z', { phase: 'complete' }),
      mark('workspace_closed', '2026-10-18T18:41:21.000Z', { phase: 'complete' }),
    ];

    expect(phaseTimesOf(marks)).toEqual({
      planning: 51_000,
      implementing: 756_000,
      review: 30_000,
    });
    expect(activeTimeOf(marks)).toBe(51_000 + 756_000 + 30_000);
  });

  // Accept as is, then the Apply finds the checkout changed a file the run also changed and sends
  // the run back to review in the same process, with no new resume.
  it('counts the review that Apply sends the run back to after Accept as is', () => {
    const marks = [
      mark('workflow_started', '2026-10-19T14:00:00.000Z', { phase: 'planning' }),
      mark('runner_call_started', '2026-10-19T14:00:01.000Z', { phase: 'planning' }),
      mark('runner_call_started', '2026-10-19T14:01:00.000Z', { phase: 'implementing' }),
      mark('runner_call_started', '2026-10-19T14:02:00.000Z', { phase: 'final-review' }),
      mark('recovery_prompted', '2026-10-19T14:03:00.000Z', { phase: 'final-review' }),
      mark('recovery_action_selected', '2026-10-19T14:05:00.000Z', { phase: 'final-review' }),
      mark('recovery_resolved', '2026-10-19T14:05:00.100Z', { phase: 'complete' }),
      mark('workflow_resumed', '2026-10-19T14:05:01.000Z', { phase: 'complete', inProcess: true }),
      mark('planner_text', '2026-10-19T14:05:02.000Z', { phase: 'final-review' }),
      mark('review_started', '2026-10-19T14:05:03.000Z', { phase: 'final-review' }),
      mark('runner_call_started', '2026-10-19T14:05:04.000Z', { phase: 'final-review' }),
      mark('runner_call_completed', '2026-10-19T14:06:34.000Z', { phase: 'final-review' }),
      mark('review_completed', '2026-10-19T14:06:35.000Z', { phase: 'final-review' }),
      mark('workflow_complete', '2026-10-19T14:06:35.100Z', { phase: 'complete' }),
    ];

    expect(phaseTimesOf(marks)).toEqual({
      planning: 60_000,
      implementing: 60_000,
      review: 60_000 + 93_100,
    });
    expect(activeTimeOf(marks)).toBe(60_000 + 60_000 + 60_000 + 93_100);
  });

  it('leaves out what an End at rest writes days after a crashed process', () => {
    const marks = [
      mark('workflow_started', '2026-10-10T10:00:00.000Z', { phase: 'planning' }),
      mark('task_started', '2026-10-10T10:01:00.000Z', { phase: 'implementing' }),
      mark('runner_call_error', '2026-10-10T10:05:00.000Z', { phase: 'implementing' }),
      mark('workspace_closed', '2026-10-13T10:05:00.020Z', { phase: 'implementing' }),
      mark('workflow_cancelled', '2026-10-13T10:05:00.030Z', {
        phase: 'implementing',
        atRestFrom: at('2026-10-13T10:05:00.000Z'),
      }),
    ];

    expect(phaseTimesOf(marks)).toEqual({ planning: MIN, implementing: 4 * MIN });
  });

  it('keeps the phase of the mark before a line that names none, and null for a run never started', () => {
    const marks = [
      mark('workflow_started', '2026-10-15T10:00:00.000Z', { phase: 'planning' }),
      mark('warning', '2026-10-15T10:01:00.000Z'),
      mark('task_started', '2026-10-15T10:02:00.000Z', { phase: 'implementing' }),
      mark('workflow_complete', '2026-10-15T10:03:00.000Z'),
    ];

    expect(phaseTimesOf(marks)).toEqual({ planning: 2 * MIN, implementing: MIN });
    expect(phaseTimesOf([mark('warning', '2026-10-15T10:00:00.000Z')])).toBeNull();
  });
});

describe('readRunMarks', () => {
  let projectDir: string | undefined;
  afterEach(() => {
    if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  function sessionWith(lines: string): { projectDir: string; sessionId: string } {
    projectDir = mkdtempSync(join(tmpdir(), 'active-time-'));
    const ref = { projectDir, sessionId: 'run' };
    mkdirSync(sessionDir(projectDir, ref.sessionId), { recursive: true });
    writeFileSync(join(sessionDir(projectDir, ref.sessionId), SESSION_LOG_FILE), lines);
    return ref;
  }

  // An older log: a stop recorded as a cancellation, a stop with no `at`, a resume with no fields.
  it('reads an old log to the time it ran, and an End at rest a day later adds none', () => {
    const log = readFileSync('testing/fixtures/session-log/long-park.jsonl', 'utf8');
    const ref = sessionWith(log);
    const marks = readRunMarks(ref) ?? [];

    expect(activeTimeOf(marks)).toBe(15 * MIN);
    expect(phaseTimesOf(marks)).toEqual({ implementing: 15 * MIN });
    const ended = [
      ...marks,
      mark('workflow_cancelled', '2026-09-16T08:05:00.000Z', {
        atRestFrom: at('2026-09-16T08:05:00.000Z'),
      }),
    ];
    expect(activeTimeOf(ended)).toBe(15 * MIN);
  });

  it('ends a stretch on an old halt line that today’s event schema refuses', () => {
    const ref = sessionWith(
      [
        '{"kind":"event","ts":"2026-09-14T09:41:00.000Z","type":"workflow_started","phase":"implementing","data":{"feature":"f"}}',
        '{"kind":"event","ts":"2026-09-14T09:42:00.000Z","type":"recovery_prompted","phase":"implementing","data":{}}',
        '{"kind":"event","ts":"2026-09-14T14:00:00.000Z","type":"warning","phase":"implementing","data":{}}',
        '{"kind":"message","ts":"2026-09-14T14:00:01.000Z","role":"user","text":"later"}',
        'not json',
      ].join('\n'),
    );

    expect(activeTimeOf(readRunMarks(ref) ?? [])).toBe(MIN);
  });

  it('reads the epoch-millisecond times older logs wrote, the resume fields and an End at rest', () => {
    const ref = sessionWith(
      [
        '{"kind":"event","ts":1757000000000,"type":"workflow_started","data":{"feature":"f"}}',
        '{"kind":"event","ts":"1757000005000","type":"workflow_resumed","data":{"inProcess":true,"resumedAt":1757000004000}}',
        '{"kind":"event","ts":1757000009000,"type":"workflow_cancelled","data":{"atRestFrom":1757000008000}}',
      ].join('\n'),
    );

    expect(readRunMarks(ref)).toEqual([
      { type: 'workflow_started', ts: 1_757_000_000_000 },
      {
        type: 'workflow_resumed',
        ts: 1_757_000_005_000,
        inProcess: true,
        resumedAt: 1_757_000_004_000,
      },
      { type: 'workflow_cancelled', ts: 1_757_000_009_000, atRestFrom: 1_757_000_008_000 },
    ]);
    expect(phaseTimesOf(readRunMarks(ref) ?? [])).toEqual({});
  });

  it('has no marks without a log, or with a symlinked one', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'active-time-'));
    expect(readRunMarks({ projectDir, sessionId: 'none' })).toBeNull();

    const dir = sessionDir(projectDir, 'linked');
    mkdirSync(dir, { recursive: true });
    copyFileSync('testing/fixtures/session-log/long-park.jsonl', join(projectDir, 'elsewhere'));
    symlinkSync(join(projectDir, 'elsewhere'), join(dir, SESSION_LOG_FILE));
    expect(readRunMarks({ projectDir, sessionId: 'linked' })).toBeNull();
  });
});
