import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  writeFileSync,
  mkdirSync,
  symlinkSync,
  appendFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readEvents,
  readMessages,
  readSessionLog,
  readSessionLogWithDiagnostics,
  readCompactedMessages,
} from './log-reader.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR } from '../paths.js';
import { SESSION_LOG_MAX_ENTRY_BYTES } from '../schemas/session-log.js';
import type { StructuredSummary } from '../schemas/compaction.js';

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
  const sessionPath = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
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
    const sessionPath = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
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

describe('readCompactedMessages', () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'splitbrief-compact-read-'));
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  function logFile(): string {
    return join(sessionDir, 'session.jsonl');
  }

  function appendEntry(entry: unknown): void {
    appendFileSync(logFile(), `${JSON.stringify(entry)}\n`);
  }

  it('returns all messages when no summary exists', async () => {
    appendEntry({
      ts: '2024-01-01T00:00:00.000Z',
      kind: 'event',
      type: 'workflow_started',
      data: {},
    });
    appendEntry({ ts: '2024-01-01T00:00:01.000Z', kind: 'message', role: 'user', text: 'spec' });
    appendEntry({
      ts: '2024-01-01T00:00:02.000Z',
      kind: 'message',
      role: 'assistant',
      text: 'plan',
    });

    const messages = await readCompactedMessages(sessionDir);

    expect(messages).toEqual([
      { ts: '2024-01-01T00:00:01.000Z', kind: 'message', role: 'user', text: 'spec' },
      { ts: '2024-01-01T00:00:02.000Z', kind: 'message', role: 'assistant', text: 'plan' },
    ]);
  });

  it('uses the latest summary and only messages after its boundary', async () => {
    for (let index = 0; index < 6; index++) {
      appendEntry({
        ts: 1000 + index,
        kind: 'message',
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `msg ${index}`,
      });
    }
    appendEntry({ ts: 2000, kind: 'summary', text: 'older summary', summarizedUpTo: 1001 });
    appendEntry({ ts: 3000, kind: 'summary', text: 'latest summary', summarizedUpTo: 1003 });

    const messages = await readCompactedMessages(sessionDir);

    expect(messages.map((message) => ({ role: message.role, text: message.text }))).toEqual([
      { role: 'user', text: 'latest summary' },
      { role: 'user', text: 'msg 4' },
      { role: 'assistant', text: 'msg 5' },
    ]);
  });

  it('uses structured summary JSON when present', async () => {
    const structured: StructuredSummary = {
      goal: 'resume with structure',
      stepsCompleted: ['compacted old turns'],
      currentStep: 'continue planning',
      filesModified: ['src/core/sessions/log-reader.ts'],
      constraintsDiscovered: ['summary augments raw turns'],
      remainingWork: ['run tests'],
    };
    appendEntry({ ts: 1000, kind: 'message', role: 'user', text: 'old' });
    appendEntry({ ts: 1001, kind: 'message', role: 'assistant', text: 'old response' });
    appendEntry({
      ts: 2000,
      kind: 'summary',
      text: 'freeform fallback text',
      summarizedUpTo: 1001,
      structured,
    });
    appendEntry({ ts: 2001, kind: 'message', role: 'user', text: 'recent' });

    const messages = await readCompactedMessages(sessionDir);

    expect(messages.map((message) => ({ role: message.role, text: message.text }))).toEqual([
      { role: 'user', text: JSON.stringify(structured) },
      { role: 'user', text: 'recent' },
    ]);
  });

  it('keeps a recent message whose timestamp equals the last summarized one via summarizedCount', async () => {
    appendEntry({ ts: 1000, kind: 'message', role: 'user', text: 'old request' });
    appendEntry({ ts: 1001, kind: 'message', role: 'assistant', text: 'old answer' });
    appendEntry({ ts: 1001, kind: 'message', role: 'user', text: 'kept on boundary' });
    appendEntry({ ts: 1002, kind: 'message', role: 'assistant', text: 'kept later' });
    appendEntry({
      ts: 2000,
      kind: 'summary',
      text: 'summary',
      summarizedUpTo: 1001,
      summarizedCount: 2,
    });

    const messages = await readCompactedMessages(sessionDir);

    expect(messages.map((message) => ({ role: message.role, text: message.text }))).toEqual([
      { role: 'user', text: 'summary' },
      { role: 'user', text: 'kept on boundary' },
      { role: 'assistant', text: 'kept later' },
    ]);
  });
});
