import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_INPUT_HISTORY } from './input-history.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

/**
 * Disk-backed history persistence. Behaviour is observed through the real
 * filesystem: HOME is pointed at a tmpDir so homedir() resolves to a real
 * path we own for the test.
 *
 * The persistence module and `inputHistoryStore` import are loaded fresh after
 * HOME is set so they share the same store references.
 */

let tmpHome: string;
let historyFile: string;
let originalHome: string | undefined;
let teardown: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  tmpHome = createTempDir('input-history-persist');
  historyFile = join(tmpHome, '.splitbrief', 'history');
  originalHome = process.env['HOME'];
  process.env['HOME'] = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  if (teardown) {
    teardown();
    teardown = null;
  }
  vi.useRealTimers();
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  cleanupTempDir(tmpHome);
});

function seedHistoryFile(content: string): void {
  mkdirSync(join(tmpHome, '.splitbrief'), { recursive: true });
  writeFileSync(historyFile, content);
}

/** Import a fresh module tree (post-resetModules) so the store and the
 *  persistence module are the same references. */
async function loadModules() {
  const mod = await import('./persistence.js');
  const { inputHistoryStore } = await import('./input-history.js');
  return { ...mod, inputHistoryStore };
}

describe('loadHistoryFromDisk', () => {
  it('reads entries from disk newest-first', async () => {
    seedHistoryFile('add user authentication\n/skills\nfix login bug');

    const { loadHistoryFromDisk } = await loadModules();
    expect(loadHistoryFromDisk()).toEqual(['add user authentication', '/skills', 'fix login bug']);
  });

  it('returns empty array when file is missing', async () => {
    const { loadHistoryFromDisk } = await loadModules();
    expect(loadHistoryFromDisk()).toEqual([]);
  });

  it('warns and returns empty array when the history path cannot be read as a file', async () => {
    mkdirSync(historyFile, { recursive: true });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const { loadHistoryFromDisk } = await loadModules();
      expect(loadHistoryFromDisk()).toEqual([]);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('input-history: failed to load'));
    } finally {
      stderr.mockRestore();
    }
  });

  it('ignores blank lines', async () => {
    seedHistoryFile('first\n\nsecond\n');
    const { loadHistoryFromDisk } = await loadModules();
    expect(loadHistoryFromDisk()).toEqual(['first', 'second']);
  });

  it('deduplicates before capping entries from disk', async () => {
    const duplicated = Array.from({ length: MAX_INPUT_HISTORY }, () => 'same');
    const olderUnique = Array.from({ length: MAX_INPUT_HISTORY }, (_, i) => `older-${i}`);
    seedHistoryFile([...duplicated, ...olderUnique].join('\n'));

    const { loadHistoryFromDisk } = await loadModules();
    const entries = loadHistoryFromDisk();

    expect(entries).toHaveLength(MAX_INPUT_HISTORY);
    expect(entries[0]).toBe('same');
    expect(entries.at(-1)).toBe(`older-${MAX_INPUT_HISTORY - 2}`);
  });
});

describe('installHistoryPersistence', () => {
  it('hydrates the store from disk on install', async () => {
    seedHistoryFile('alpha\nbeta');

    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    expect(inputHistoryStore.get().entries).toEqual(['alpha', 'beta']);
  });

  it('push triggers a debounced save to disk after 300ms', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    inputHistoryStore.push('hello');
    expect(existsSync(historyFile)).toBe(false);

    vi.advanceTimersByTime(300);

    expect(existsSync(historyFile)).toBe(true);
    expect(readFileSync(historyFile, 'utf-8')).toBe('hello');
  });

  it('does not write transcript-off workflow prompts to disk but still persists home and slash history', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    inputHistoryStore.pushSubmission('unique workflow prompt never persisted', {
      currentScreen: 'workflow',
      persistTranscript: false,
    });
    vi.advanceTimersByTime(300);

    expect(existsSync(historyFile)).toBe(false);

    inputHistoryStore.pushSubmission('home feature persists', {
      currentScreen: 'home',
      persistTranscript: false,
    });
    inputHistoryStore.pushSubmission('/resume', {
      currentScreen: 'workflow',
      persistTranscript: false,
    });
    vi.advanceTimersByTime(300);

    const saved = readFileSync(historyFile, 'utf-8');
    expect(saved).toBe('/resume\nhome feature persists');
    expect(saved).not.toContain('unique workflow prompt never persisted');
  });

  it('debounces: multiple pushes within 300ms produce a single disk write', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    inputHistoryStore.push('first');
    vi.advanceTimersByTime(100);
    inputHistoryStore.push('second');
    vi.advanceTimersByTime(100);
    inputHistoryStore.push('third');
    vi.advanceTimersByTime(300);

    // File holds the most-recent store state (newest-first, deduped).
    expect(readFileSync(historyFile, 'utf-8')).toBe('third\nsecond\nfirst');
  });

  it('redacts secrets before saving history to disk', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    inputHistoryStore.push('token sk-abcdefghijklmnopqrst');
    teardown();
    teardown = null;

    const saved = readFileSync(historyFile, 'utf-8');
    expect(saved).toBe('token sk-***REDACTED***');
    expect(saved).not.toContain('abcdefghijklmnopqrst');
  });

  it('write failures in the timer callback do not throw unhandled errors', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    // Pre-create the target path AS a directory so writeSecureFile's
    // writeFileSync fails with EISDIR — a genuine disk error surfaced by the
    // real module, not a mock.
    mkdirSync(historyFile, { recursive: true });

    inputHistoryStore.push('hello');
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
  });

  it('teardown flushes pending writes and stops subscribing to further pushes', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    const stop = installHistoryPersistence();

    inputHistoryStore.push('pending');
    stop();
    vi.advanceTimersByTime(300);

    expect(readFileSync(historyFile, 'utf-8')).toBe('pending');

    // Further pushes post-teardown do not trigger writes either.
    inputHistoryStore.push('after-teardown');
    vi.advanceTimersByTime(300);
    expect(readFileSync(historyFile, 'utf-8')).toBe('pending');
  });

  it('reinstalling flushes prior pending writes and replaces subscriptions', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    const firstStop = installHistoryPersistence();

    inputHistoryStore.push('stale pending');
    teardown = installHistoryPersistence();
    vi.advanceTimersByTime(300);

    expect(readFileSync(historyFile, 'utf-8')).toBe('stale pending');

    firstStop();
    inputHistoryStore.push('active install');
    vi.advanceTimersByTime(300);

    expect(readFileSync(historyFile, 'utf-8')).toBe('active install\nstale pending');
  });
});
