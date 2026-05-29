import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_INPUT_HISTORY } from './input-history.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

/**
 * Disk-backed history persistence. Behaviour is observed through the real
 * filesystem: HOME is pointed at a tmpDir so the module's homedir()-derived
 * HISTORY_FILE constant resolves to a real path we own for the test.
 *
 * Because persistence.ts snapshots `HISTORY_FILE` at module-load time, both
 * the persistence module AND its `inputHistoryStore` import must be loaded
 * fresh AFTER HOME is set — otherwise the store the test pushes into is not
 * the store the newly-evaluated persistence module is subscribed to.
 */

let tmpHome: string;
let historyFile: string;
let originalHome: string | undefined;
let teardown: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  tmpHome = createTempDir('input-history-persist');
  historyFile = join(tmpHome, '.diptych', 'history');
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
  mkdirSync(join(tmpHome, '.diptych'), { recursive: true });
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

  it('caps entries at MAX_INPUT_HISTORY', async () => {
    const lines = Array.from({ length: MAX_INPUT_HISTORY + 3 }, (_, i) => `item-${i}`);
    seedHistoryFile(lines.join('\n'));

    const { loadHistoryFromDisk } = await loadModules();
    expect(loadHistoryFromDisk()).toHaveLength(MAX_INPUT_HISTORY);
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

  it('saves under ~/.diptych/history (HOME-relative)', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    inputHistoryStore.push('test entry');
    vi.advanceTimersByTime(300);

    expect(existsSync(historyFile)).toBe(true);
    expect(readFileSync(historyFile, 'utf-8')).toBe('test entry');
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

  it('teardown cancels pending writes and stops subscribing to further pushes', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    const stop = installHistoryPersistence();

    inputHistoryStore.push('pending');
    stop();
    vi.advanceTimersByTime(300);

    // Pending save cancelled by teardown.
    expect(existsSync(historyFile)).toBe(false);

    // Further pushes post-teardown do not trigger writes either.
    inputHistoryStore.push('after-teardown');
    vi.advanceTimersByTime(300);
    expect(existsSync(historyFile)).toBe(false);
  });

  it('reinstalling cancels prior pending writes and subscriptions', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    const firstStop = installHistoryPersistence();

    inputHistoryStore.push('stale pending');
    teardown = installHistoryPersistence();
    vi.advanceTimersByTime(300);

    expect(existsSync(historyFile)).toBe(false);

    firstStop();
    inputHistoryStore.push('active install');
    vi.advanceTimersByTime(300);

    expect(readFileSync(historyFile, 'utf-8')).toBe('active install');
  });
});
