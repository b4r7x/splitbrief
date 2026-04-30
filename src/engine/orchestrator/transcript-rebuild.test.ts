import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../core/paths.js';
import { buildResumeContext } from './transcript-rebuild.js';

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

  it('returns empty array with no warning when no session log exists and persist is true', async () => {
    const { projectDir, sessionId } = setupProject();
    const result = await buildResumeContext(projectDir, sessionId, true);
    expect(result.messages).toEqual([]);
    expect(result.warning).toBeUndefined();
  });
});

