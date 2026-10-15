import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { type BriefMark, briefWorkedMs, readBriefWorkedMs } from './worked-time.js';

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
const STOPPED_AND_CONTINUED: BriefMark[] = [
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

describe('briefWorkedMs', () => {
  it('counts the stretch a stopped brief worked, not the time it sat stopped', () => {
    expect(briefWorkedMs(STOPPED_AND_CONTINUED, 'T001', LATER)).toBe(38_727);
  });

  it('is 0 for a brief with no earlier stretch', () => {
    expect(
      briefWorkedMs(
        [
          mark('workflow_started', '2026-10-15T17:00:00Z'),
          mark('tasks_planned', '2026-10-15T17:01:00Z'),
        ],
        'T001',
        LATER,
      ),
    ).toBe(0);
    expect(
      briefWorkedMs(
        [
          mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
          mark('task_completed', '2026-10-15T17:02:00Z', 'T001'),
        ],
        'T002',
        LATER,
      ),
    ).toBe(0);
  });

  it('adds every stretch of a brief stopped twice', () => {
    expect(
      briefWorkedMs(
        [
          mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
          mark('turn_interrupted', '2026-10-15T17:00:10Z'),
          mark('workflow_resumed', '2026-10-15T18:00:00Z'),
          mark('task_started', '2026-10-15T18:00:01Z', 'T001'),
          mark('turn_interrupted', '2026-10-15T18:00:21Z'),
        ],
        'T001',
        LATER,
      ),
    ).toBe(30_000);
  });

  it('ends a stretch at the halt, not at the answer hours later', () => {
    expect(
      briefWorkedMs(
        [
          mark('task_started', '2026-10-15T12:00:00Z', 'T001'),
          mark('recovery_prompted', '2026-10-15T12:00:42Z'),
          mark('recovery_resolved', '2026-10-15T17:00:00Z'),
          mark('workflow_resumed', '2026-10-15T17:00:01Z'),
        ],
        'T001',
        LATER,
      ),
    ).toBe(42_000);
  });

  it('ends a crashed stretch at its latest mark, the cut call the restart records included', () => {
    expect(
      briefWorkedMs(
        [
          mark('task_started', '2026-10-12T09:00:00Z', 'T001'),
          mark('runner_call_usage', '2026-10-12T09:00:20Z', 'T001'),
          mark('runner_call_error', '2026-10-12T09:00:05Z', 'T001'),
          mark('workflow_resumed', '2026-10-15T09:00:00Z'),
        ],
        'T001',
        LATER,
      ),
    ).toBe(20_000);
  });

  it('runs the stretch still open at the end of the log to now', () => {
    expect(
      briefWorkedMs(
        [
          mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
          mark('consult_requested', '2026-10-15T17:00:07Z', 'T001'),
        ],
        'T001',
        at('2026-10-15T17:00:30Z'),
      ),
    ).toBe(30_000);
  });

  it('counts the stretch a steer continued in process before a stop and a Continue', () => {
    expect(
      briefWorkedMs(
        [
          mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
          mark('runner_call_started', '2026-10-15T17:00:01Z', 'T001'),
          cutOf('T001', '2026-10-15T17:00:10Z'),
          mark('runner_call_started', '2026-10-15T17:00:12Z', 'T001'),
          mark('runner_call_usage', '2026-10-15T17:01:00Z', 'T001'),
          cutOf('T001', '2026-10-15T17:01:12Z'),
          mark('workflow_resumed', '2026-10-16T09:00:00Z'),
          mark('task_started', '2026-10-16T09:00:01Z', 'T001'),
        ],
        'T001',
        at('2026-10-16T09:00:21Z'),
      ),
    ).toBe(10_000 + 60_000 + 20_000);
  });

  it('leaves out the time a watchdog park waited for /resume', () => {
    expect(
      briefWorkedMs(
        [
          mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
          cutOf('T001', '2026-10-15T17:05:00Z'),
          mark('warning', '2026-10-15T17:05:01Z'),
          mark('runner_call_started', '2026-10-15T19:00:00Z', 'T001'),
        ],
        'T001',
        at('2026-10-15T19:00:40Z'),
      ),
    ).toBe(300_000 + 40_000);
  });

  it('opens no stretch for a cut that another brief or a halt settled', () => {
    expect(
      briefWorkedMs(
        [
          mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
          cutOf('T001', '2026-10-15T17:00:10Z'),
          mark('recovery_prompted', '2026-10-15T17:00:11Z'),
          mark('runner_call_started', '2026-10-15T18:00:00Z', 'T001'),
        ],
        'T001',
        LATER,
      ),
    ).toBe(10_000);
    expect(
      briefWorkedMs(
        [
          mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
          mark('turn_interrupted', '2026-10-15T17:00:10Z'),
          mark('runner_call_started', '2026-10-15T18:00:00Z', 'T001'),
        ],
        'T001',
        LATER,
      ),
    ).toBe(10_000);
  });

  it('keeps counting across a redo, and starts again after the brief ended', () => {
    const redo = [
      mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
      mark('recovery_prompted', '2026-10-15T17:00:10Z'),
      mark('task_reset', '2026-10-15T17:05:00Z', 'T001'),
      mark('task_started', '2026-10-15T17:05:01Z', 'T001'),
      mark('turn_interrupted', '2026-10-15T17:05:06Z'),
    ];
    expect(briefWorkedMs(redo, 'T001', LATER)).toBe(15_000);
    expect(
      briefWorkedMs(
        [
          ...redo,
          mark('task_started', '2026-10-15T17:06:00Z', 'T001'),
          mark('task_completed', '2026-10-15T17:06:30Z', 'T001'),
        ],
        'T001',
        LATER,
      ),
    ).toBe(0);
  });

  it('does not count another brief stopped and continued', () => {
    expect(
      briefWorkedMs(
        [
          mark('task_started', '2026-10-15T17:00:00Z', 'T001'),
          mark('task_completed', '2026-10-15T17:00:30Z', 'T001'),
          mark('task_started', '2026-10-15T17:00:31Z', 'T002'),
          mark('turn_interrupted', '2026-10-15T17:01:31Z'),
          mark('workflow_resumed', '2026-10-15T17:30:00Z'),
        ],
        'T001',
        LATER,
      ),
    ).toBe(0);
  });
});

describe('readBriefWorkedMs', () => {
  let projectDir: string | undefined;
  afterEach(() => {
    if (projectDir !== undefined) cleanupTempDir(projectDir);
    projectDir = undefined;
  });

  function writeLog(lines: readonly string[]): { projectDir: string; sessionId: string } {
    projectDir = createTempDir('worked-time');
    const sessionId = 'run-1';
    const dir = sessionDir(projectDir, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SESSION_LOG_FILE), `${lines.join('\n')}\n`);
    return { projectDir, sessionId };
  }

  it('reads the stretches of a brief from a log with top-level task ids', async () => {
    const ref = writeLog([
      '{"ts":"2026-10-15T17:05:48.351Z","kind":"event","type":"workflow_started","phase":"planning","data":{"feature":"range"}}',
      '{"ts":"2026-10-15T17:06:59.904Z","kind":"event","type":"task_started","taskId":"T001","phase":"implementing","data":{"title":"Add range helper with tests","index":0,"total":1}}',
      '{"ts":"2026-10-15T17:07:37.684Z","kind":"event","type":"runner_call_usage","taskId":"T001","phase":"implementing","data":{}}',
      '{"ts":"2026-10-15T17:07:38.315Z","kind":"message","role":"assistant","phase":"implementing","text":"","interrupted":true}',
      '{"ts":"2026-10-15T17:07:38.631Z","kind":"event","type":"turn_interrupted","phase":"implementing","data":{"source":"user","at":"mid-step","step":{"kind":"brief","taskId":"T001","attempt":0}}}',
      '{"ts":"2026-10-15T17:07:53.698Z","kind":"event","type":"workflow_resumed","phase":"implementing","data":{}}',
    ]);
    expect(await readBriefWorkedMs(ref, 'T001')).toBe(38_727);
  });

  it('reads the brief a mid-step stop cut from its step, and its stretch the steer continued', async () => {
    const ref = writeLog([
      '{"ts":"2026-10-15T17:00:00.000Z","kind":"event","type":"task_started","taskId":"T001","phase":"implementing","data":{}}',
      '{"ts":"2026-10-15T17:00:10.000Z","kind":"event","type":"turn_interrupted","phase":"implementing","data":{"source":"user","at":"mid-step","step":{"kind":"brief","taskId":"T001","attempt":0}}}',
      '{"ts":"2026-10-15T17:00:12.000Z","kind":"message","role":"user","phase":"implementing","text":"use the helper"}',
      '{"ts":"2026-10-15T17:00:12.000Z","kind":"event","type":"runner_call_started","taskId":"T001","phase":"implementing","data":{}}',
      '{"ts":"2026-10-15T17:01:12.000Z","kind":"event","type":"turn_interrupted","phase":"implementing","data":{"source":"user","at":"mid-step","step":{"kind":"brief","taskId":"T001","attempt":0}}}',
      '{"ts":"2026-10-16T09:00:00.000Z","kind":"event","type":"workflow_resumed","phase":"implementing","data":{}}',
    ]);
    expect(await readBriefWorkedMs(ref, 'T001')).toBe(70_000);
  });

  it('reads the task id an older log keeps in the event data', async () => {
    const fixture = readFileSync(
      join(import.meta.dirname, '../../../../testing/fixtures/session-log/long-park.jsonl'),
      'utf8',
    );
    const ref = writeLog(fixture.split('\n').slice(0, 7));
    expect(await readBriefWorkedMs(ref, 'T002')).toBe(307_000);
  });

  it('is 0 when the run has no log', async () => {
    projectDir = createTempDir('worked-time');
    expect(await readBriefWorkedMs({ projectDir, sessionId: 'none' }, 'T001')).toBe(0);
  });
});
