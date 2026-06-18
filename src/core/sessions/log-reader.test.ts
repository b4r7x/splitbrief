import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  readEvents,
  readMessages,
  readSessionLog,
  readSessionLogWithDiagnostics,
} from './log-reader.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../paths.js';
import { SESSION_LOG_MAX_ENTRY_BYTES } from '../schemas/session-log.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

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

  it('reports skipped malformed, invalid, and oversized lines when diagnostics are requested', async () => {
    const dir = makeTmp();
    writeFixture(dir, [
      FIXTURE_LINES[0] ?? '',
      'NOT VALID JSON{{{',
      JSON.stringify({ kind: 'message', ts: '2024-01-01T00:00:01.000Z', role: 'robot' }),
      'x'.repeat(SESSION_LOG_MAX_ENTRY_BYTES + 1),
      '',
      FIXTURE_LINES[1] ?? '',
    ]);

    const result = await readSessionLogWithDiagnostics({ projectDir: dir, sessionId: SESSION_ID });

    expect(result.entries).toHaveLength(2);
    expect(result.diagnostics).toMatchObject({
      totalLines: 6,
      yieldedEntries: 2,
      skippedBlank: 1,
      skippedMalformed: 1,
      skippedInvalid: 1,
      skippedOversized: 1,
    });
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

  itUnix('treats a symlinked session.jsonl as empty', async () => {
    const dir = makeTmp();
    const outside = createTempDir('log-reader-outside');
    const sessionPath = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
    try {
      mkdirSync(sessionPath, { recursive: true });
      writeFileSync(join(outside, 'session.jsonl'), FIXTURE_LINES.join('\n') + '\n');
      symlinkSync(join(outside, 'session.jsonl'), join(sessionPath, 'session.jsonl'));

      const entries = await collect(readSessionLog({ projectDir: dir, sessionId: SESSION_ID }));
      expect(entries).toHaveLength(0);
      const result = await readSessionLogWithDiagnostics({
        projectDir: dir,
        sessionId: SESSION_ID,
      });
      expect(result.diagnostics.skippedSymlink).toBe(1);
    } finally {
      cleanupTempDir(outside);
    }
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
