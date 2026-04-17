import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inputHistoryStore } from '../stores/ui/input-history.js';

const MAX_INPUT_HISTORY = 10;

vi.mock('node:os', () => ({ homedir: () => '/home/testuser' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn() };
});
vi.mock('../lib/fs.js', () => ({ writeSecureFile: vi.fn(), ensureSecureDir: vi.fn() }));

describe('input-history-persistence', () => {
  let teardown: (() => void) | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();
    inputHistoryStore.reset();
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockReset();
    const { writeSecureFile } = await import('../lib/fs.js');
    vi.mocked(writeSecureFile).mockReset();
  });

  afterEach(() => {
    if (teardown) {
      teardown();
      teardown = null;
    }
    vi.useRealTimers();
  });

  describe('loadHistoryFromDisk', () => {
    it('reads entries from disk newest-first', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue('add user authentication\n/skills\nfix login bug');

      const { loadHistoryFromDisk } = await import('./input-history-persistence.js');
      const entries = loadHistoryFromDisk();

      expect(entries).toEqual([
        'add user authentication',
        '/skills',
        'fix login bug',
      ]);
    });

    it('returns empty array when file is missing', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const { loadHistoryFromDisk } = await import('./input-history-persistence.js');
      const entries = loadHistoryFromDisk();

      expect(entries).toEqual([]);
    });

    it('ignores blank lines', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue('first\n\nsecond\n');

      const { loadHistoryFromDisk } = await import('./input-history-persistence.js');
      const entries = loadHistoryFromDisk();

      expect(entries).toEqual(['first', 'second']);
    });

    it('caps entries at MAX_INPUT_HISTORY', async () => {
      const { readFileSync } = await import('node:fs');
      const lines = Array.from({ length: MAX_INPUT_HISTORY + 3 }, (_, i) => `item-${i}`);
      vi.mocked(readFileSync).mockReturnValue(lines.join('\n'));

      const { loadHistoryFromDisk } = await import('./input-history-persistence.js');
      const entries = loadHistoryFromDisk();

      expect(entries).toHaveLength(MAX_INPUT_HISTORY);
    });
  });

  describe('installHistoryPersistence', () => {
    it('hydrates the store from disk on install', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue('alpha\nbeta');

      const { installHistoryPersistence } = await import('./input-history-persistence.js');
      teardown = installHistoryPersistence();

      expect(inputHistoryStore.get().entries).toEqual(['alpha', 'beta']);
    });

    it('push triggers a debounced save after 300ms', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      const { writeSecureFile } = await import('../lib/fs.js');

      const { installHistoryPersistence } = await import('./input-history-persistence.js');
      teardown = installHistoryPersistence();

      inputHistoryStore.push('hello');
      expect(vi.mocked(writeSecureFile)).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);
      expect(vi.mocked(writeSecureFile)).toHaveBeenCalledOnce();
      expect(vi.mocked(writeSecureFile)).toHaveBeenCalledWith(
        expect.stringContaining('history'),
        'hello',
      );
    });

    it('debounces: multiple pushes within 300ms produce a single save', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      const { writeSecureFile } = await import('../lib/fs.js');

      const { installHistoryPersistence } = await import('./input-history-persistence.js');
      teardown = installHistoryPersistence();

      inputHistoryStore.push('first');
      vi.advanceTimersByTime(100);
      inputHistoryStore.push('second');
      vi.advanceTimersByTime(100);
      inputHistoryStore.push('third');
      vi.advanceTimersByTime(300);

      expect(vi.mocked(writeSecureFile)).toHaveBeenCalledOnce();
      expect(vi.mocked(writeSecureFile)).toHaveBeenCalledWith(
        expect.stringContaining('history'),
        'third\nsecond\nfirst',
      );
    });

    it('saves to ~/.diptych/history', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      const { writeSecureFile } = await import('../lib/fs.js');

      const { installHistoryPersistence } = await import('./input-history-persistence.js');
      teardown = installHistoryPersistence();

      inputHistoryStore.push('test entry');
      vi.advanceTimersByTime(300);

      expect(vi.mocked(writeSecureFile)).toHaveBeenCalledWith(
        '/home/testuser/.diptych/history',
        'test entry',
      );
    });

    it('write failures in the timer callback do not throw unhandled errors', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      const { writeSecureFile } = await import('../lib/fs.js');
      vi.mocked(writeSecureFile).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const { installHistoryPersistence } = await import('./input-history-persistence.js');
      teardown = installHistoryPersistence();

      inputHistoryStore.push('hello');
      expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    });

    it('teardown cancels pending writes and unsubscribes', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      const { writeSecureFile } = await import('../lib/fs.js');

      const { installHistoryPersistence } = await import('./input-history-persistence.js');
      const stop = installHistoryPersistence();

      inputHistoryStore.push('pending');
      stop();
      vi.advanceTimersByTime(300);

      expect(vi.mocked(writeSecureFile)).not.toHaveBeenCalled();

      // After teardown, further pushes don't trigger writes either
      inputHistoryStore.push('after-teardown');
      vi.advanceTimersByTime(300);
      expect(vi.mocked(writeSecureFile)).not.toHaveBeenCalled();
    });
  });
});
