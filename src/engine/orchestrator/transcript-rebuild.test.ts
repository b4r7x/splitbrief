import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../core/paths.js';
import { saveState } from '../../core/state/persistence.js';
import { createInitialState } from '../../core/state/machine.js';
import {
  buildResumeContext,
  compactResumeTranscript,
  keepRecentCountForThreshold,
} from './transcript-rebuild.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('transcript-rebuild-test');
  dirs.push(projectDir);
  const sessionId = 'sess-transcript';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function writeSessionLog(projectDir: string, sessionId: string, entries: unknown[]): void {
  const filePath = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

describe('keepRecentCountForThreshold', () => {
  it('returns threshold minus one for typical values', () => {
    expect(keepRecentCountForThreshold(10)).toBe(9);
    expect(keepRecentCountForThreshold(20)).toBe(19);
  });

  it('clamps to at least 1', () => {
    expect(keepRecentCountForThreshold(1)).toBe(1);
    expect(keepRecentCountForThreshold(0)).toBe(1);
  });
});

describe('buildResumeContext', () => {
  it('returns empty messages with warning when persistTranscript is false', async () => {
    const { projectDir, sessionId } = setupProject();
    const result = await buildResumeContext(projectDir, sessionId, false);
    expect(result.messages).toEqual([]);
    expect(result.warning).toBe('transcript-unavailable');
  });

  it('collects messages from the real session log on disk', async () => {
    const { projectDir, sessionId } = setupProject();
    const now = new Date().toISOString();
    // Write a real jsonl session log that the real readSessionLog will parse.
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: now, role: 'user', phase: 'planning', text: 'hello' },
      { kind: 'message', ts: now, role: 'assistant', phase: 'planning', text: 'hi there' },
      // A non-message entry should be filtered out by readMessages.
      { kind: 'event', ts: now, type: 'workflow_started', phase: 'idle', data: {} },
    ]);

    const result = await buildResumeContext(projectDir, sessionId, true);
    expect(result.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    expect(result.warning).toBeUndefined();
  });

  it('rebuilds compacted sessions from the latest summary plus later messages', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'old request' },
      { kind: 'message', ts: 1001, role: 'assistant', phase: 'planning', text: 'old answer' },
      { kind: 'summary', ts: 2000, text: '## Summary\nOld work preserved', summarizedUpTo: 1001 },
      { kind: 'message', ts: 2001, role: 'user', phase: 'planning', text: 'new request' },
      { kind: 'message', ts: 2002, role: 'assistant', phase: 'planning', text: 'new answer' },
    ]);

    const result = await buildResumeContext(projectDir, sessionId, true);

    expect(result.messages).toEqual([
      { role: 'user', content: '## Summary\nOld work preserved' },
      { role: 'user', content: 'new request' },
      { role: 'assistant', content: 'new answer' },
    ]);
  });

  it('returns empty array with no warning when no session log exists and persist is true', async () => {
    const { projectDir, sessionId } = setupProject();
    const result = await buildResumeContext(projectDir, sessionId, true);
    expect(result.messages).toEqual([]);
    expect(result.warning).toBeUndefined();
  });

  it('annotates a cut-off assistant turn so the planner is not re-fed a partial turn as complete', async () => {
    const { projectDir, sessionId } = setupProject();
    const now = new Date().toISOString();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: now, role: 'user', phase: 'planning', text: 'do the thing' },
      {
        kind: 'message',
        ts: now,
        role: 'assistant',
        phase: 'planning',
        text: 'I will start by',
        interrupted: true,
      },
    ]);

    const result = await buildResumeContext(projectDir, sessionId, true);

    expect(result.messages).toEqual([
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'I will start by\n\n[turn interrupted]' },
    ]);
  });

  it('annotates a cut-off assistant turn that survives compaction as a kept recent message', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'old request' },
      { kind: 'message', ts: 1001, role: 'assistant', phase: 'planning', text: 'old answer' },
      { kind: 'summary', ts: 2000, text: '## Summary\nOld work preserved', summarizedUpTo: 1001 },
      { kind: 'message', ts: 2001, role: 'user', phase: 'planning', text: 'new request' },
      {
        kind: 'message',
        ts: 2002,
        role: 'assistant',
        phase: 'planning',
        text: 'partial new answer',
        interrupted: true,
      },
    ]);

    const result = await buildResumeContext(projectDir, sessionId, true);

    expect(result.messages).toEqual([
      { role: 'user', content: '## Summary\nOld work preserved' },
      { role: 'user', content: 'new request' },
      { role: 'assistant', content: 'partial new answer\n\n[turn interrupted]' },
    ]);
  });

  it('excludes still-pending queued user messages so resume drains them only once', async () => {
    const { projectDir, sessionId } = setupProject();
    const queuedAt = new Date().toISOString();
    const state = {
      ...createInitialState('feature'),
      phase: 'planning' as const,
      messageQueue: [
        {
          id: 'msg-pending',
          text: 'still queued',
          queuedAt,
          phase: 'planning' as const,
          deliveredViaNative: false,
          nativeDeliveryState: 'pending' as const,
        },
      ],
    };
    saveState({ projectDir, sessionId }, state);
    writeSessionLog(projectDir, sessionId, [
      {
        kind: 'message',
        ts: queuedAt,
        role: 'user',
        phase: 'planning',
        text: 'still queued',
        queuedAt,
        queueMessageId: 'msg-pending',
      },
      { kind: 'message', ts: queuedAt, role: 'assistant', phase: 'planning', text: 'working' },
    ]);

    const result = await buildResumeContext(projectDir, sessionId, true);

    expect(result.messages).toEqual([{ role: 'assistant', content: 'working' }]);
  });

  it('filters pending queued messages from compacted resume without replaying summarized raw turns', async () => {
    const { projectDir, sessionId } = setupProject();
    const queuedAt = '2026-01-01T00:00:03.000Z';
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('feature'),
        phase: 'planning' as const,
        messageQueue: [
          {
            id: 'msg-pending',
            text: 'pending queued after summary',
            queuedAt,
            phase: 'planning' as const,
            deliveredViaNative: false,
            nativeDeliveryState: 'pending' as const,
          },
        ],
      },
    );
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'old request' },
      { kind: 'message', ts: 1001, role: 'assistant', phase: 'planning', text: 'old answer' },
      { kind: 'summary', ts: 2000, text: '## Summary\nOld work preserved', summarizedUpTo: 1001 },
      {
        kind: 'message',
        ts: queuedAt,
        role: 'user',
        phase: 'planning',
        text: 'pending queued after summary',
        queuedAt,
        queueMessageId: 'msg-pending',
      },
      { kind: 'message', ts: 3000, role: 'assistant', phase: 'planning', text: 'later answer' },
      { kind: 'message', ts: 3001, role: 'user', phase: 'planning', text: 'later request' },
    ]);

    const result = await buildResumeContext(projectDir, sessionId, true);

    expect(result.messages).toEqual([
      { role: 'user', content: '## Summary\nOld work preserved' },
      { role: 'assistant', content: 'later answer' },
      { role: 'user', content: 'later request' },
    ]);
  });
});

describe('compactResumeTranscript', () => {
  it('surfaces the planner usage from the summarization call', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'first' },
      { kind: 'message', ts: 1001, role: 'assistant', phase: 'planning', text: 'second' },
      { kind: 'message', ts: 1002, role: 'user', phase: 'planning', text: 'third' },
    ]);

    const result = await compactResumeTranscript({
      projectDir,
      sessionId,
      keepRecentCount: 1,
      planner: {
        summarize: async () => ({
          text: '## Summary',
          usage: { inputTokens: 1200, outputTokens: 90 },
        }),
      },
    });

    expect(result.summary).toBe('## Summary');
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 90 });
  });

  it('returns null usage when nothing needs summarizing', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'only message' },
    ]);

    const result = await compactResumeTranscript({
      projectDir,
      sessionId,
      keepRecentCount: 10,
      planner: {
        summarize: async () => {
          throw new Error('should not summarize');
        },
      },
    });

    expect(result.entriesRemoved).toBe(0);
    expect(result.usage).toBeNull();
  });
});
