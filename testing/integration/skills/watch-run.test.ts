import { execFile } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const exec = promisify(execFile);
const skill = fileURLToPath(new URL('../../../skills/splitbrief-babysit', import.meta.url));
let scratch: string;
let session: string;
let cursor: string;
let script: string;

beforeEach(() => {
  scratch = createTempDir('babysit-watch');
  session = join(scratch, 'session');
  mkdirSync(session);
  cpSync(skill, join(scratch, 'installed-skill'), { recursive: true });
  script = join(scratch, 'installed-skill/scripts/watch-run.mjs');
  cursor = join(scratch, 'cursor.json');
  writeFileSync(join(session, 'session.jsonl'), '');
  writeFileSync(join(session, 'state.json'), JSON.stringify({ phase: 'implementing', tasks: [] }));
});

afterEach(() => cleanupTempDir(scratch));

async function watch(seconds = '0') {
  const result = await exec(process.execPath, [script, session, cursor, seconds], {
    cwd: scratch,
    env: { PATH: '/usr/bin:/bin' },
  });
  return JSON.parse(result.stdout);
}

function append(type: string, data: object = {}) {
  appendFileSync(join(session, 'session.jsonl'), JSON.stringify({ type, data }) + '\n');
}

describe('standalone babysit watcher', () => {
  it('wakes only for failed or refused reviewer checks', async () => {
    append('full_suite', { status: 'running' });
    append('full_suite', { status: 'done', passed: true });
    append('full_suite', { status: 'not-run', detail: 'V1 failed' });
    append('full_suite', { status: 'done' });
    append('full_suite', { status: 'done', passed: false });
    append('full_suite', { status: 'running', moment: 'base' });
    append('full_suite', { status: 'refused', detail: 'the script changed' });

    expect((await watch()).event.detail).toContain('"passed":false');
    expect((await watch()).event.detail).toContain('"status":"refused"');
    expect((await watch()).status).toBe('tick');
  });

  it('reports the first error and preserves errors written between calls', async () => {
    append('runner_call_text_delta', { text: 'progress' });
    append('runner_call_error', { message: 'adapter failed' });
    const first = await watch();
    expect(first.event.type).toBe('runner_call_error');
    expect(first.event.detail).toContain('adapter failed');

    append('checks_run', { taskId: 'T001', results: [{ id: 'C1', passed: false }] });
    append('task_retry', { attempt: 2 });
    expect((await watch()).event.type).toBe('checks_run');
    expect((await watch()).event.type).toBe('task_retry');
    expect((await watch()).status).toBe('tick');
  });

  it('retains a partial UTF-8 line until it is complete', async () => {
    const bytes = Buffer.from(JSON.stringify({ type: 'error', data: { message: 'błąd' } }) + '\n');
    const split = bytes.indexOf(Buffer.from('ą')) + 1;
    appendFileSync(join(session, 'session.jsonl'), bytes.subarray(0, split));
    expect((await watch()).incompleteLogLine).toBe(true);
    appendFileSync(join(session, 'session.jsonl'), bytes.subarray(split));
    expect((await watch()).event.detail).toContain('błąd');
    expect((await watch()).status).toBe('tick');
  });

  it('streams past a large history without losing the first actionable event', async () => {
    for (let i = 0; i < 80; i += 1) append('runner_call_text_delta', { text: 'x'.repeat(32_000) });
    append('runner_call_warning', { message: 'parse mismatch' });
    expect((await watch('5')).event.type).toBe('runner_call_warning');
  });

  it('wakes for an event appended during a wait', async () => {
    const waiting = watch('5');
    const timer = setTimeout(() => append('runner_call_error', { message: 'live failure' }), 100);
    try {
      expect((await waiting).event.detail).toContain('live failure');
    } finally {
      clearTimeout(timer);
    }
  });

  it('reports persisted recovery even with no new events', async () => {
    writeFileSync(
      join(session, 'state.json'),
      JSON.stringify({
        phase: 'halted',
        tasks: [],
        pendingRecovery: { reason: 'runner-usage-limit' },
      }),
    );
    expect(await watch()).toMatchObject({ status: 'recovery', recovery: 'runner-usage-limit' });
  });

  it('fails visibly on malformed events without consuming them', async () => {
    await watch();
    const saved = readFileSync(cursor, 'utf8');
    appendFileSync(join(session, 'session.jsonl'), '{broken}\n');
    await expect(watch()).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('watcher-error:'),
    });
    expect(readFileSync(cursor, 'utf8')).toBe(saved);
  });

  it('rejects a truncated log and refuses a cursor belonging to another run', async () => {
    append('error');
    await watch();
    writeFileSync(join(session, 'session.jsonl'), '');
    await expect(watch()).rejects.toMatchObject({ code: 2 });
    const other = join(scratch, 'other');
    cpSync(session, other, { recursive: true });
    await expect(exec(process.execPath, [script, other, cursor, '0'])).rejects.toMatchObject({
      code: 2,
    });
  });
});
