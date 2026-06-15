import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DIPTYCH_DIR, SESSIONS_DIR, SESSION_LOG_FILE } from '../../core/paths.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTranscriptBuffer } from './transcript-buffer.js';

const SESSION_ID = '2026-05-14-transcript-buffer-test';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function readEntries(projectDir: string, sessionId: string): unknown[] {
  const logPath = join(projectDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId, SESSION_LOG_FILE);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe('createTranscriptBuffer', () => {
  it('flush() persists buffered text as an assistant message entry', () => {
    tmp = createTempDir('transcript-buffer');
    const buf = createTranscriptBuffer({
      projectDir: tmp,
      sessionId: SESSION_ID,
      phase: 'planning',
      persistTranscript: true,
    });

    buf.append('hello ');
    buf.append('world');
    buf.flush();

    const entries = readEntries(tmp, SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        phase: 'planning',
        text: 'hello world',
      }),
    );
  });

  it('writes nothing when persistTranscript is false', () => {
    tmp = createTempDir('transcript-buffer');
    const buf = createTranscriptBuffer({
      projectDir: tmp,
      sessionId: SESSION_ID,
      phase: 'planning',
      persistTranscript: false,
    });

    buf.append('ignored');
    buf.flush();
    buf.flushInterrupted();

    const logPath = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, SESSION_LOG_FILE);
    expect(existsSync(logPath)).toBe(false);
  });

  it('writes nothing when sessionId is empty', () => {
    tmp = createTempDir('transcript-buffer');
    const buf = createTranscriptBuffer({
      projectDir: tmp,
      sessionId: '',
      phase: 'planning',
      persistTranscript: true,
    });

    buf.append('still no persistence');
    buf.flush();

    const sessionsPath = join(tmp, DIPTYCH_DIR, SESSIONS_DIR);
    if (existsSync(sessionsPath)) {
      const empty = join(sessionsPath, '', SESSION_LOG_FILE);
      expect(existsSync(empty)).toBe(false);
    }
  });

  it('flushInterrupted() marks the entry as interrupted', () => {
    tmp = createTempDir('transcript-buffer');
    const buf = createTranscriptBuffer({
      projectDir: tmp,
      sessionId: SESSION_ID,
      phase: 'implementing',
      persistTranscript: true,
    });

    buf.append('partial output');
    buf.flushInterrupted();

    const entries = readEntries(tmp, SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        phase: 'implementing',
        text: 'partial output',
        interrupted: true,
      }),
    );
  });

  it('auto-persists when the buffer grows beyond the threshold', () => {
    tmp = createTempDir('transcript-buffer');
    const buf = createTranscriptBuffer({
      projectDir: tmp,
      sessionId: SESSION_ID,
      phase: undefined,
      persistTranscript: true,
    });

    const blob = 'x'.repeat(17_000);
    buf.append(blob);

    const entries = readEntries(tmp, SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        text: blob,
      }),
    );
    expect((entries[0] as { phase?: string }).phase).toBeUndefined();
  });

  it('auto-persists multibyte text by byte size, not UTF-16 code-unit count', () => {
    tmp = createTempDir('transcript-buffer');
    const buf = createTranscriptBuffer({
      projectDir: tmp,
      sessionId: SESSION_ID,
      phase: undefined,
      persistTranscript: true,
    });

    // Each '한' is one UTF-16 code unit but three UTF-8 bytes. 6000 chars is well under the
    // 16 KiB code-unit count yet ~18 KiB of bytes, so byte-aware flushing must persist it.
    const blob = '한'.repeat(6000);
    expect(blob.length).toBeLessThan(16 * 1024);
    expect(Buffer.byteLength(blob, 'utf8')).toBeGreaterThan(16 * 1024);
    buf.append(blob);

    const entries = readEntries(tmp, SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        text: blob,
      }),
    );
  });

  it('flush() on an empty buffer is a no-op', () => {
    tmp = createTempDir('transcript-buffer');
    const buf = createTranscriptBuffer({
      projectDir: tmp,
      sessionId: SESSION_ID,
      phase: 'planning',
      persistTranscript: true,
    });

    buf.flush();
    buf.flushInterrupted();

    const logPath = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, SESSION_LOG_FILE);
    expect(existsSync(logPath)).toBe(false);
  });
});
