import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readSessionLog, readMessages, readEvents } from './log-reader.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../paths.js';

let tmp: string;
const SESSION_ID = '2024-01-01-test';

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function makeTmp(): string {
  tmp = createTempDir('log-reader');
  return tmp;
}

function writeFixture(dir: string, lines: string[]): void {
  const sessionPath = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
  mkdirSync(sessionPath, { recursive: true });
  writeFileSync(join(sessionPath, 'session.jsonl'), lines.join('\n') + '\n');
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) results.push(item);
  return results;
}

const FIXTURE_LINES = [
  JSON.stringify({
    ts: '2024-01-01T00:00:00.000Z',
    kind: 'event',
    type: 'workflow_started',
    phase: 'idle',
    data: {},
  }),
  JSON.stringify({
    ts: '2024-01-01T00:00:01.000Z',
    kind: 'message',
    role: 'user',
    text: 'add auth',
  }),
  JSON.stringify({
    ts: '2024-01-01T00:00:02.000Z',
    kind: 'event',
    type: 'task_started',
    phase: 'implementing',
    data: {},
  }),
  JSON.stringify({
    ts: '2024-01-01T00:00:03.000Z',
    kind: 'message',
    role: 'assistant',
    phase: 'researching',
    text: 'planner output',
  }),
];

describe('readSessionLog', () => {
  it('returns all entries in order', async () => {
    const dir = makeTmp();
    writeFixture(dir, FIXTURE_LINES);
    const entries = await collect(readSessionLog({ projectDir: dir, sessionId: SESSION_ID }));
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ kind: 'event', type: 'workflow_started' });
    expect(entries[1]).toMatchObject({ kind: 'message', role: 'user' });
  });

  it('returns empty when file does not exist', async () => {
    const dir = makeTmp();
    const entries = await collect(readSessionLog({ projectDir: dir, sessionId: SESSION_ID }));
    expect(entries).toHaveLength(0);
  });

  it('skips corrupt lines without throwing', async () => {
    const dir = makeTmp();
    writeFixture(dir, [FIXTURE_LINES[0] ?? '', 'NOT VALID JSON{{{', FIXTURE_LINES[1] ?? '']);
    const entries = await collect(readSessionLog({ projectDir: dir, sessionId: SESSION_ID }));
    expect(entries).toHaveLength(2);
  });

  it('skips blank lines', async () => {
    const dir = makeTmp();
    writeFixture(dir, [FIXTURE_LINES[0] ?? '', '', '   ', FIXTURE_LINES[1] ?? '']);
    const entries = await collect(readSessionLog({ projectDir: dir, sessionId: SESSION_ID }));
    expect(entries).toHaveLength(2);
  });

  it('rejects invalid session ids', async () => {
    const dir = makeTmp();
    await expect(
      collect(readSessionLog({ projectDir: dir, sessionId: '../outside' })),
    ).rejects.toThrow('Invalid session id');
  });
});

describe('readMessages', () => {
  it('yields only kind:message entries', async () => {
    const dir = makeTmp();
    writeFixture(dir, FIXTURE_LINES);
    const messages = await collect(readMessages({ projectDir: dir, sessionId: SESSION_ID }));
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.kind === 'message')).toBe(true);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
  });
});

describe('readEvents', () => {
  it('yields only kind:event entries', async () => {
    const dir = makeTmp();
    writeFixture(dir, FIXTURE_LINES);
    const events = await collect(readEvents({ projectDir: dir, sessionId: SESSION_ID }));
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === 'event')).toBe(true);
  });
});
