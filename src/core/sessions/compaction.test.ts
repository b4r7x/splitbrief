import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactTranscript, type TranscriptCompactionPlanner } from './compaction.js';
import { readCompactedMessages } from './log-reader.js';
import type { StructuredSummary } from '../schemas/compaction.js';

let sessionDir: string;
const itUnix = process.platform === 'win32' ? it.skip : it;

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
  return readLogLines().map((line) => JSON.parse(line) as Record<string, unknown>);
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

    const result = await compactTranscript({
      sessionDir,
      planner,
      keepRecentCount: 2,
      format: 'freeform',
    });

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

  it('records summarizedCount so a kept message on the boundary timestamp survives a re-read', async () => {
    appendEntry({ ts: 1000, kind: 'message', role: 'user', text: 'msg 0' });
    appendEntry({ ts: 1001, kind: 'message', role: 'assistant', text: 'msg 1' });
    appendEntry({ ts: 1001, kind: 'message', role: 'user', text: 'msg 2 same ts' });
    appendEntry({ ts: 1002, kind: 'message', role: 'assistant', text: 'msg 3' });
    const planner: TranscriptCompactionPlanner = {
      summarize: async () => '## Summary\nOlder work',
    };

    const result = await compactTranscript({
      sessionDir,
      planner,
      keepRecentCount: 2,
      format: 'freeform',
    });

    expect(result).toEqual({ summary: '## Summary\nOlder work', entriesRemoved: 2 });
    expect(readLogEntries().at(-1)).toMatchObject({ kind: 'summary', summarizedCount: 2 });

    const messages = await readCompactedMessages(sessionDir);
    expect(messages.map((message) => ({ role: message.role, text: message.text }))).toEqual([
      { role: 'user', text: '## Summary\nOlder work' },
      { role: 'user', text: 'msg 2 same ts' },
      { role: 'assistant', text: 'msg 3' },
    ]);
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

    const result = await compactTranscript({ sessionDir, planner, format: 'freeform' });

    expect(result).toEqual({ summary: '', entriesRemoved: 0 });
    expect(summarizeCalls).toBe(0);
    expect(readFileSync(logFile(), 'utf-8')).toBe('');
  });

  it('appends structured summary data in structured mode', async () => {
    for (let index = 0; index < 5; index++) {
      appendEntry({
        ts: 1000 + index,
        kind: 'message',
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `msg ${index}`,
      });
    }
    const structured: StructuredSummary = {
      goal: 'ship compaction',
      stepsCompleted: ['read transcript'],
      currentStep: 'summarizing',
      filesModified: ['src/core/sessions/compaction.ts'],
      constraintsDiscovered: ['append-only log'],
      remainingWork: ['verify resume'],
    };
    const planner: TranscriptCompactionPlanner = {
      summarize: async () => 'unused',
      summarizeStructured: async () => ({ text: JSON.stringify(structured), structured }),
    };

    const result = await compactTranscript({
      sessionDir,
      planner,
      keepRecentCount: 2,
      format: 'structured',
    });

    expect(result).toEqual({
      summary: JSON.stringify(structured),
      entriesRemoved: 3,
      structured,
    });
    expect(readLogEntries().at(-1)).toMatchObject({
      kind: 'summary',
      text: JSON.stringify(structured),
      structured,
      summarizedUpTo: '1002',
    });
  });

  it('passes the previous structured summary to structured summarization', async () => {
    const previousStructured: StructuredSummary = {
      goal: 'existing goal',
      stepsCompleted: ['old step'],
      currentStep: 'old current',
      filesModified: ['old.ts'],
      constraintsDiscovered: ['old constraint'],
      remainingWork: ['old work'],
    };
    appendEntry({
      ts: 500,
      kind: 'summary',
      text: JSON.stringify(previousStructured),
      summarizedUpTo: 999,
      structured: previousStructured,
    });
    for (let index = 0; index < 3; index++) {
      appendEntry({
        ts: 1000 + index,
        kind: 'message',
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `msg ${index}`,
      });
    }
    let receivedPrevious: StructuredSummary | undefined;
    const planner: TranscriptCompactionPlanner = {
      summarize: async () => 'unused',
      summarizeStructured: async (_messages, previous) => {
        receivedPrevious = previous;
        const structured = { ...previousStructured, currentStep: 'new current' };
        return { text: JSON.stringify(structured), structured };
      },
    };

    await compactTranscript({
      sessionDir,
      planner,
      keepRecentCount: 1,
      format: 'structured',
    });

    expect(receivedPrevious).toEqual(previousStructured);
  });

  it('merges only new messages after the previous structured summary boundary', async () => {
    const previousStructured: StructuredSummary = {
      goal: 'existing goal',
      stepsCompleted: ['old step'],
      currentStep: 'old current',
      filesModified: ['old.ts'],
      constraintsDiscovered: ['old constraint'],
      remainingWork: ['old work'],
    };
    for (let index = 0; index < 6; index++) {
      appendEntry({
        ts: 1000 + index,
        kind: 'message',
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `msg ${index}`,
      });
    }
    appendEntry({
      ts: 2000,
      kind: 'summary',
      text: JSON.stringify(previousStructured),
      summarizedUpTo: 1001,
      structured: previousStructured,
    });
    let summarizedInput: Array<{ role: string; text: string }> = [];
    const planner: TranscriptCompactionPlanner = {
      summarize: async () => 'unused',
      summarizeStructured: async (messages, previous) => {
        summarizedInput = messages;
        const structured = {
          ...(previous ?? previousStructured),
          stepsCompleted: [...previousStructured.stepsCompleted, 'new step'],
        };
        return { text: JSON.stringify(structured), structured };
      },
    };

    await compactTranscript({
      sessionDir,
      planner,
      keepRecentCount: 2,
      format: 'structured',
    });

    expect(summarizedInput).toEqual([
      { role: 'user', text: 'msg 2' },
      { role: 'assistant', text: 'msg 3' },
    ]);
  });

  it('falls back to raw summary text when structured summarization fails validation', async () => {
    for (let index = 0; index < 4; index++) {
      appendEntry({
        ts: 1000 + index,
        kind: 'message',
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `msg ${index}`,
      });
    }
    const planner: TranscriptCompactionPlanner = {
      summarize: async () => 'unused',
      summarizeStructured: async () => ({ text: 'not json', structured: null }),
    };
    const fallbackTexts: string[] = [];
    const onFallback = (text: string) => {
      fallbackTexts.push(text);
    };

    const result = await compactTranscript({
      sessionDir,
      planner,
      keepRecentCount: 1,
      format: 'structured',
      onFallback,
    });

    expect(result).toEqual({ summary: 'not json', entriesRemoved: 3, structured: null });
    expect(fallbackTexts).toEqual(['not json']);
    expect(readLogEntries().at(-1)).toMatchObject({
      kind: 'summary',
      text: 'not json',
      summarizedUpTo: '1002',
    });
    expect(readLogEntries().at(-1)).not.toHaveProperty('structured');
  });

  itUnix('refuses to append compaction summary through a symlinked session log', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'compact-outside-'));
    try {
      const outsideLog = join(outside, 'session.jsonl');
      writeFileSync(outsideLog, '');
      symlinkSync(outsideLog, logFile());
      appendEntry({ ts: 1000, kind: 'message', role: 'user', text: 'hello' });

      const planner: TranscriptCompactionPlanner = {
        summarize: async () => 'summary text',
      };

      await expect(
        compactTranscript({
          sessionDir,
          planner,
          format: 'freeform',
          keepRecentCount: 0,
        }),
      ).rejects.toThrow(/refusing to write through symlink/);
      const lines = readFileSync(outsideLog, 'utf-8').trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"kind":"message"');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
