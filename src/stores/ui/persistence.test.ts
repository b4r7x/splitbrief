import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_INPUT_HISTORY } from './input-history.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

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

  it('saves under ~/.diptych/history (HOME-relative)', async () => {
    const { installHistoryPersistence, inputHistoryStore } = await loadModules();
    teardown = installHistoryPersistence();

    inputHistoryStore.push('test entry');
    vi.advanceTimersByTime(300);

    expect(existsSync(historyFile)).toBe(true);
    expect(readFileSync(historyFile, 'utf-8')).toBe('test entry');
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

describe('transcript-off session artifact privacy', () => {
  it('omits the feature prompt from session metadata, summaries, export, ps, and branch names', async () => {
    vi.useRealTimers();
    const projectDir = createTempDir('session-privacy');
    const uniquePrompt = 'sentinel-privacy-leak-771299';
    createTestGitRepo(projectDir);

    try {
      const { runWorkflow, WORKFLOW_REWIND_ABORT_REASON } = await import(
        '../../engine/orchestrator/run/workflow.js'
      );
      const { readActive } = await import('../../core/sessions/lifecycle.js');
      const { DIPTYCH_DIR, LOCKFILE, SESSIONS_DIR } = await import('../../core/paths.js');
      const { listAllSessions } = await import('../../core/sessions/io.js');
      const { writeSessionHtmlReport } = await import('../../engine/export/collect.js');
      const { psCommand } = await import('../../cli/commands/ps.js');
      const { simpleGit } = await import('simple-git');

      const controller = new AbortController();
      controller.abort(WORKFLOW_REWIND_ABORT_REASON);
      const summary = await runWorkflow({
        feature: uniquePrompt,
        projectDir,
        config: makeConfig({
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: {
            git: { createBranch: true, commitStrategy: 'none' },
            mode: 'quick',
            persistTranscript: false,
          },
        }),
        callbacks: makeCallbacks().callbacks,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        signal: controller.signal,
        _planner: makePlanner(),
      });

      const sessionsPath = join(projectDir, DIPTYCH_DIR, SESSIONS_DIR);
      const sessionIds = readdirSync(sessionsPath);
      expect(sessionIds).toHaveLength(1);
      const sessionId = sessionIds[0] ?? '';
      const sessionPath = join(sessionsPath, sessionId);
      const active = readActive(projectDir);
      const lockfile = readFileSync(join(sessionPath, LOCKFILE), 'utf-8');
      const summaryJson = readFileSync(join(sessionPath, 'summary.json'), 'utf-8');
      const sessions = listAllSessions(projectDir);
      const exportResult = writeSessionHtmlReport(sessionPath, sessionId);
      expect(exportResult.status).toBe('ok');
      const html = readFileSync(join(sessionPath, 'report.html'), 'utf-8');

      const psLines: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
        psLines.push(line);
      });
      try {
        await psCommand({ projectDir });
      } finally {
        log.mockRestore();
      }

      const branch = (await simpleGit(projectDir).status()).current;
      const inspected = [
        sessionId,
        active ?? '',
        lockfile,
        summaryJson,
        JSON.stringify(summary),
        JSON.stringify(sessions),
        html,
        psLines.join('\n'),
        branch,
      ].join('\n');

      expect(inspected).not.toContain(uniquePrompt);
      expect(sessionId).toMatch(/^\d{4}-\d{2}-\d{2}-session-[a-f0-9]{12}$/);
      expect(branch).toMatch(/^diptych\/session-[a-f0-9]{12}$/);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
