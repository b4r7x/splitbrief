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
import { activeTimeOf, readRunMarks, type RunMark } from './active-time.js';

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
