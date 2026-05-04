import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactTranscript, type TranscriptCompactionPlanner } from './compaction.js';
import { readCompactedMessages } from './log-reader.js';

let sessionDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'diptych-compact-'));
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

function readLogLines(): string[] {
  return readFileSync(logFile(), 'utf-8').trimEnd().split('\n');
}

function readLogEntries(): Array<Record<string, unknown>> {
  return readLogLines().map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('compactTranscript', () => {
  it('appends a summary without removing transcript lines', async () => {
    for (let index = 0; index < 5; index++) {
      appendEntry({
        ts: 1000 + index,
        kind: 'message',
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `msg ${index}`,
      });
    }
    appendEntry({ ts: 2000, kind: 'event', type: 'workflow_started', data: {} });
    const originalLines = readLogLines();
    let summarizedInput: Array<{ role: string; text: string }> = [];
    const planner: TranscriptCompactionPlanner = {
      summarize: async (messages) => {
        summarizedInput = messages;
        return '## Summary\nOlder work';
      },
    };

    const result = await compactTranscript(sessionDir, planner, 2);

    expect(result).toEqual({ summary: '## Summary\nOlder work', entriesRemoved: 3 });
    expect(summarizedInput).toEqual([
      { role: 'user', text: 'msg 0' },
      { role: 'assistant', text: 'msg 1' },
      { role: 'user', text: 'msg 2' },
    ]);
    const lines = readLogLines();
    expect(lines.slice(0, originalLines.length)).toEqual(originalLines);
    expect(lines).toHaveLength(originalLines.length + 1);
    expect(readLogEntries().at(-1)).toMatchObject({
      kind: 'summary',
      text: '## Summary\nOlder work',
      summarizedUpTo: '1002',
    });
  });

  it('handles an empty session without appending a summary', async () => {
    appendFileSync(logFile(), '');
    let summarizeCalls = 0;
    const planner: TranscriptCompactionPlanner = {
      summarize: async () => {
        summarizeCalls += 1;
        return 'unused';
      },
    };

    const result = await compactTranscript(sessionDir, planner);

    expect(result).toEqual({ summary: '', entriesRemoved: 0 });
    expect(summarizeCalls).toBe(0);
    expect(readFileSync(logFile(), 'utf-8')).toBe('');
  });
});

describe('readCompactedMessages', () => {
  it('returns all messages when no summary exists', async () => {
    appendEntry({ ts: '2024-01-01T00:00:00.000Z', kind: 'event', type: 'workflow_started', data: {} });
    appendEntry({ ts: '2024-01-01T00:00:01.000Z', kind: 'message', role: 'user', text: 'spec' });
    appendEntry({ ts: '2024-01-01T00:00:02.000Z', kind: 'message', role: 'assistant', text: 'plan' });

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

    expect(messages.map(message => ({ role: message.role, text: message.text }))).toEqual([
      { role: 'user', text: 'latest summary' },
      { role: 'user', text: 'msg 4' },
      { role: 'assistant', text: 'msg 5' },
    ]);
  });
});
