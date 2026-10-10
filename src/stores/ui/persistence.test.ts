import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDraftDocument } from '../../core/composer/document.js';
import { prepareDraftSubmission } from '../../core/composer/submission.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { draftDocumentText, MAX_INPUT_HISTORY } from './input-history.js';
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

function savedTexts(): string[] {
  const envelope = JSON.parse(readFileSync(historyFile, 'utf-8')) as { entries: DraftDocument[] };
  return envelope.entries.map(draftDocumentText);
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
    expect(loadHistoryFromDisk()).toEqual([
      createDraftDocument('add user authentication'),
      createDraftDocument('/skills'),
      createDraftDocument('fix login bug'),
    ]);
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
    expect(loadHistoryFromDisk().map(draftDocumentText)).toEqual(['first', 'second']);
  });

  it('strips ANSI escapes and raw controls from legacy disk lines', async () => {
    seedHistoryFile('first\u0007 line\n\u001b[31mred\u001b[0m\u007f second\tkept');

    const { loadHistoryFromDisk } = await loadModules();
    const entries = loadHistoryFromDisk().map(draftDocumentText);
    expect(entries).toEqual(['first line', 'red second\tkept']);
  });

  it('deduplicates before capping entries from disk', async () => {
    const duplicated = Array.from({ length: MAX_INPUT_HISTORY }, () => 'same');
    const olderUnique = Array.from({ length: MAX_INPUT_HISTORY }, (_, i) => `older-${i}`);
    seedHistoryFile([...duplicated, ...olderUnique].join('\n'));

    const { loadHistoryFromDisk } = await loadModules();
    const entries = loadHistoryFromDisk().map(draftDocumentText);

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

    expect(inputHistoryStore.get().entries.map(draftDocumentText)).toEqual(['alpha', 'beta']);
  });

  it('sanitizes a versioned envelope on install and preserves image metadata', async () => {
    const attachment = {
      id: 'img-1',
      kind: 'image' as const,
      path: join(tmpHome, 'shot.png'),
      mimeType: 'image/png',
      sizeBytes: 4,
    };
    seedHistoryFile(
      JSON.stringify({
        version: 1,
        entries: [
          {
            version: 1,
            parts: [
              { kind: 'text', text: '\u001b[31mred\u001b[0m\u0007 \u007fkept' },
              { kind: 'image', attachment },
              { kind: 'text', text: '\n\u0000tail' },
            ],
          },
        ],
      }),
    );

    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    expect(inputHistoryStore.get().entries).toEqual([
      {
        version: 1,
        parts: [
          { kind: 'text', text: 'red kept' },
          { kind: 'image', attachment },
          { kind: 'text', text: '\ntail' },
        ],
      },
    ]);
  });

  it('push triggers a debounced save to disk after 300ms', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    inputHistoryStore.push('hello');
    expect(existsSync(historyFile)).toBe(false);

    vi.advanceTimersByTime(300);

    expect(existsSync(historyFile)).toBe(true);
    expect(savedTexts()).toEqual(['hello']);
  });

  it('persists submissions from every screen to disk', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    inputHistoryStore.pushDocumentSubmission(createDraftDocument('home feature persists'), {
      currentScreen: 'home',
    });
    inputHistoryStore.pushDocumentSubmission(createDraftDocument('workflow prompt persists'), {
      currentScreen: 'workflow',
    });
    vi.advanceTimersByTime(300);

    expect(savedTexts()).toEqual(['workflow prompt persists', 'home feature persists']);
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
    expect(savedTexts()).toEqual(['third', 'second', 'first']);
  });

  it('redacts secrets before saving history to disk', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    inputHistoryStore.push('token sk-abcdefghijklmnopqrst');
    teardown();
    teardown = null;

    expect(savedTexts()).toEqual(['token sk-***REDACTED***']);
    expect(readFileSync(historyFile, 'utf-8')).not.toContain('abcdefghijklmnopqrst');
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

    expect(savedTexts()).toEqual(['pending']);

    // Further pushes post-teardown do not trigger writes either.
    inputHistoryStore.push('after-teardown');
    vi.advanceTimersByTime(300);
    expect(savedTexts()).toEqual(['pending']);
  });

  it('reinstalling flushes prior pending writes and replaces subscriptions', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    const firstStop = installHistoryPersistence();

    inputHistoryStore.push('stale pending');
    teardown = installHistoryPersistence();
    vi.advanceTimersByTime(300);

    expect(savedTexts()).toEqual(['stale pending']);

    firstStop();
    inputHistoryStore.push('active install');
    vi.advanceTimersByTime(300);

    expect(savedTexts()).toEqual(['active install', 'stale pending']);
  });

  it('reloads a multiline submission as one exact document and imports legacy lines once', async () => {
    seedHistoryFile('legacy [paste:1f2e3d4c] marker\nolder legacy');
    const multiline = createDraftDocument('  first line\n\n\tindented\nlast line\n');
    const first = await loadModules();
    teardown = first.installHistoryPersistence();

    first.inputHistoryStore.pushDocumentSubmission(multiline, { currentScreen: 'home' });
    teardown();
    teardown = null;

    vi.resetModules();
    const second = await loadModules();
    expect(second.loadHistoryFromDisk()).toEqual([
      multiline,
      createDraftDocument('legacy [paste:1f2e3d4c] marker'),
      createDraftDocument('older legacy'),
    ]);
  });

  it('redacts text parts on disk and stores image metadata without bytes', async () => {
    const imagePath = join(tmpHome, 'sk-abcdefghijklmnopqrst.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xde, 0xad, 0xbe, 0xef]));
    const attachment = {
      id: 'img-1',
      kind: 'image' as const,
      path: imagePath,
      mimeType: 'image/png',
      sizeBytes: 8,
    };
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    inputHistoryStore.pushDocumentSubmission(
      {
        version: 1,
        parts: [
          { kind: 'text', text: 'token sk-abcdefghijklmnopqrst\n' },
          { kind: 'image', attachment },
        ],
      },
      { currentScreen: 'home' },
    );
    teardown();
    teardown = null;

    expect(JSON.parse(readFileSync(historyFile, 'utf-8'))).toEqual({
      version: 1,
      entries: [
        {
          version: 1,
          parts: [
            { kind: 'text', text: 'token sk-***REDACTED***\n' },
            { kind: 'image', attachment },
          ],
        },
      ],
    });
  });

  it('keeps a recalled image whose file is gone and fails its next submission', async () => {
    const imagePath = join(tmpHome, 'shot.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const attachment = {
      id: 'img-1',
      kind: 'image' as const,
      path: realpathSync(imagePath),
      mimeType: 'image/png',
      sizeBytes: 4,
    };
    const recalled: DraftDocument = {
      version: 1,
      parts: [
        { kind: 'text', text: 'look at ' },
        { kind: 'image', attachment },
      ],
    };
    const first = await loadModules();
    teardown = first.installHistoryPersistence();
    first.inputHistoryStore.pushDocumentSubmission(recalled, { currentScreen: 'home' });
    teardown();
    teardown = null;
    rmSync(imagePath);

    vi.resetModules();
    const second = await loadModules();
    teardown = second.installHistoryPersistence();
    const [entry] = second.inputHistoryStore.get().entries;

    expect(entry).toEqual(recalled);
    expect(
      prepareDraftSubmission(entry ?? recalled, { projectDir: tmpHome, supportsImages: true }),
    ).toEqual({ ok: false, reason: 'not-found', imageId: 'img-1' });
  });

  it.each([
    ['truncated JSON', '{"version":1,"entries":[{"version":1,'],
    ['an invalid entry', '{"version":1,"entries":[{"version":2,"parts":"$(touch pwned)"}]}'],
  ])('warns and starts empty when the versioned envelope holds %s', async (_name, content) => {
    seedHistoryFile(content);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const { loadHistoryFromDisk } = await loadModules();
      expect(loadHistoryFromDisk()).toEqual([]);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('input-history: ignored a malformed history file'),
      );
      expect(readFileSync(historyFile, 'utf-8')).toBe(content);
      expect(existsSync(join(tmpHome, 'pwned'))).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });
});
