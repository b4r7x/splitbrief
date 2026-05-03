import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../core/paths.js';
import { buildResumeContext, keepRecentCountForThreshold } from './transcript-rebuild.js';

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
});
