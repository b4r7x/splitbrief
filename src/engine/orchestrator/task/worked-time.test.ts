import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { readBriefWorkedMs } from './worked-time.js';

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
