import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../../core/paths.js';
import { compactResumeTranscript, keepRecentCountForThreshold } from './compaction.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('transcript-compaction-test');
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
