import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { inputHistoryStore } from './input-history.js';

const MAX_INPUT_HISTORY = 10;

vi.mock('node:os', () => ({ homedir: () => '/home/testuser' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn() };
});
vi.mock('../../utils/fs.js', () => ({ writeSecureFile: vi.fn(), ensureSecureDir: vi.fn() }));

describe('inputHistoryStore', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    inputHistoryStore.reset();
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockReset();
    const { writeSecureFile } = await import('../../utils/fs.js');
    vi.mocked(writeSecureFile).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores empty values', () => {
    inputHistoryStore.push('   ');

    expect(inputHistoryStore.get().entries).toEqual([]);
  });

  it('stores trimmed values with the newest first', () => {
    inputHistoryStore.push('first');
    inputHistoryStore.push(' second ');

    expect(inputHistoryStore.get().entries).toEqual(['second', 'first']);
  });

  it('deduplicates entries by moving repeats to the front', () => {
    inputHistoryStore.push('first');
    inputHistoryStore.push('second');
    inputHistoryStore.push('first');

    expect(inputHistoryStore.get().entries).toEqual(['first', 'second']);
  });

  it('skips consecutive duplicates', () => {
    inputHistoryStore.push('first');
    inputHistoryStore.push('first');

    expect(inputHistoryStore.get().entries).toEqual(['first']);
  });

  it('caps history length', () => {
    for (let index = 0; index < MAX_INPUT_HISTORY + 2; index++) {
      inputHistoryStore.push(`item-${index}`);
    }

    expect(inputHistoryStore.get().entries).toHaveLength(MAX_INPUT_HISTORY);
    expect(inputHistoryStore.get().entries[0]).toBe('item-11');
  });

  describe('persistence', () => {
    it('load() reads entries from disk newest-first', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue('add user authentication\n/skills\nfix login bug');

      inputHistoryStore.load();

      expect(inputHistoryStore.get().entries).toEqual([
        'add user authentication',
        '/skills',
        'fix login bug',
      ]);
    });

    it('load() starts with empty history when file is missing', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });

      inputHistoryStore.load();

      expect(inputHistoryStore.get().entries).toEqual([]);
    });

    it('load() ignores blank lines', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue('first\n\nsecond\n');

      inputHistoryStore.load();

      expect(inputHistoryStore.get().entries).toEqual(['first', 'second']);
    });

    it('load() caps entries at MAX_INPUT_HISTORY', async () => {
      const { readFileSync } = await import('node:fs');
      const lines = Array.from({ length: MAX_INPUT_HISTORY + 3 }, (_, i) => `item-${i}`);
      vi.mocked(readFileSync).mockReturnValue(lines.join('\n'));

      inputHistoryStore.load();

      expect(inputHistoryStore.get().entries).toHaveLength(MAX_INPUT_HISTORY);
    });

    it('push() triggers a debounced save after 300ms', async () => {
      const { writeSecureFile } = await import('../../utils/fs.js');

      inputHistoryStore.push('hello');
      expect(vi.mocked(writeSecureFile)).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);
      expect(vi.mocked(writeSecureFile)).toHaveBeenCalledOnce();
      expect(vi.mocked(writeSecureFile)).toHaveBeenCalledWith(
        expect.stringContaining('history'),
        'hello',
      );
    });

    it('push() debounces: multiple pushes within 300ms produce a single save', async () => {
      const { writeSecureFile } = await import('../../utils/fs.js');

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

    it('save writes to ~/.diptych/history', async () => {
      const { writeSecureFile } = await import('../../utils/fs.js');

      inputHistoryStore.push('test entry');
      vi.advanceTimersByTime(300);

      expect(vi.mocked(writeSecureFile)).toHaveBeenCalledWith(
        '/home/testuser/.diptych/history',
        'test entry',
      );
    });

    it('write failures in the timer callback do not throw unhandled errors', async () => {
      const { writeSecureFile } = await import('../../utils/fs.js');
      vi.mocked(writeSecureFile).mockImplementation(() => { throw new Error('EACCES: permission denied'); });

      inputHistoryStore.push('hello');
      expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    });
  });
});
