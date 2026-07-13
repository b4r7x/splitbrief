import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  listRecentSessions,
  listSessions,
  listAllSessions,
  saveSummary,
  readSession,
} from './io.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../paths.js';
import { saveState, loadState } from '../state/persistence.js';
import { isResumable } from '../phases.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { taskId } from '../schemas/task.js';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

import type { Session } from '../schemas/session.js';

function writeSessionSubdir(projectDir: string, sessionId: string, session: Session): void {
  const subdir = join(projectDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
  mkdirSync(subdir, { recursive: true });
  writeFileSync(join(subdir, 'summary.json'), JSON.stringify(session));
}

describe('listSessions', () => {
  it('returns empty array when sessions directory does not exist', () => {
    tmp = createTempDir('sessions-io-test');
    expect(listSessions(join(tmp, 'does-not-exist'))).toEqual([]);
  });

  it('returns empty array when sessions directory is empty', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionsRoot = join(tmp, DIPTYCH_DIR, SESSIONS_DIR);
    mkdirSync(sessionsRoot, { recursive: true });
    expect(listSessions(tmp)).toEqual([]);
  });

  it('parses summary.json files from subdirectories', () => {
    tmp = createTempDir('sessions-io-test');
    writeSessionSubdir(
      tmp,
      '2024-01-01-auth',
      makeSession({ id: '2024-01-01-auth', feature: 'auth' }),
    );

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-01-auth');
    expect(sessions[0]?.feature).toBe('auth');
  });

  it('uses the directory id when summary payload id differs', () => {
    tmp = createTempDir('sessions-io-test');
    writeSessionSubdir(
      tmp,
      '2024-01-01-real',
      makeSession({ id: '2024-01-01-other', feature: 'auth' }),
    );

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-01-real');
    expect(sessions[0]?.feature).toBe('auth');
  });

  it('skips session directories with invalid ids', () => {
    tmp = createTempDir('sessions-io-test');
    writeSessionSubdir(tmp, '.invalid', makeSession({ id: '.invalid', startedAt: 3000 }));
    writeSessionSubdir(tmp, '2024-01-02-good', makeSession({ id: '2024-01-02-good' }));

    const sessions = listSessions(tmp);
    expect(sessions.map((s) => s.id)).toEqual(['2024-01-02-good']);
  });

  it('sorts sessions by startedAt descending', () => {
    tmp = createTempDir('sessions-io-test');
    writeSessionSubdir(
      tmp,
      '2024-01-01-old',
      makeSession({ id: '2024-01-01-old', startedAt: 1000 }),
    );
    writeSessionSubdir(
      tmp,
      '2024-01-02-mid',
      makeSession({ id: '2024-01-02-mid', startedAt: 2000 }),
    );
    writeSessionSubdir(
      tmp,
      '2024-01-03-new',
      makeSession({ id: '2024-01-03-new', startedAt: 3000 }),
    );

    const sessions = listSessions(tmp);
    expect(sessions.map((s) => s.id)).toEqual([
      '2024-01-03-new',
      '2024-01-02-mid',
      '2024-01-01-old',
    ]);
  });

  it('returns every stored session newest first with total = count', () => {
    tmp = createTempDir('sessions-io-test');
    for (let i = 0; i < 35; i++) {
      const id = `2024-01-01-sess-${i}`;
      writeSessionSubdir(tmp, id, makeSession({ id, startedAt: i * 1000 }));
    }

    const recent = listRecentSessions(tmp);
    expect(recent.sessions).toHaveLength(35);
    expect(recent.total).toBe(35);
    expect(recent.sessions[0]?.startedAt).toBe(34000);
    expect(recent.sessions[34]?.startedAt).toBe(0);
    expect(listSessions(tmp)).toHaveLength(35);
  });

  it('skips subdirectories with neither summary.json nor a recoverable state.json', () => {
    tmp = createTempDir('sessions-io-test');
    const emptySubdir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-empty');
    mkdirSync(emptySubdir, { recursive: true });
    writeSessionSubdir(tmp, '2024-01-02-good', makeSession({ id: '2024-01-02-good' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-02-good');
  });

  it('skips sessions with malformed summary.json and returns only the valid ones', () => {
    tmp = createTempDir('sessions-io-test');
    const badDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'summary.json'), '{not valid json!!!');
    writeSessionSubdir(tmp, '2024-01-02-good', makeSession({ id: '2024-01-02-good' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-02-good');
  });

  it('skips valid JSON with invalid schema', () => {
    tmp = createTempDir('sessions-io-test');
    const badDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'summary.json'), JSON.stringify({ id: 'x' }));
    writeSessionSubdir(tmp, '2024-01-02-good', makeSession({ id: '2024-01-02-good' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-02-good');
  });

  it('loads legacy summaries missing contextDetected without warning', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = '2024-01-01-legacy-cost-prediction';
    const session = makeSession({
      id: sessionId,
      status: 'complete',
      summary: makeSummary({
        costPrediction: {
          estimatedTasks: 1,
          lowCost: 0,
          expectedCost: 0,
          highCost: 0,
          plannerTool: 'codex',
          implementerTool: 'codex',
          deterministic: {
            taskCount: 1,
            taskFitCounts: { fits: 1, tight: 0, overflow: 0, unknown: 0 },
            contextConfidenceCounts: {
              contextExplicit: 0,
              contextDetected: 1,
              contextKnownCatalog: 0,
              contextCachedProvider: 0,
              contextConservativeFallback: 0,
              profileUnavailable: 0,
            },
            priceConfidenceCounts: { priceKnown: 0, priceUnknown: 1, profileUnavailable: 0 },
            tasks: [
              {
                taskId: taskId('T001'),
                title: 'legacy task',
                estimatedPromptTokens: 10,
                selectedProfileId: 'default',
                contextFit: 'fits',
                contextConfidence: 'context-detected',
                priceConfidence: 'price-unknown',
                estimatedImplementerCost: null,
                hypotheticalPlannerCost: null,
              },
            ],
            totals: {
              knownActualEstimate: null,
              hypotheticalAllPlanner: null,
              estimatedSavings: null,
              unknownCostReason: ['implementer-price-unknown'],
            },
          },
        },
      }),
    });
    const raw = JSON.parse(JSON.stringify(session)) as {
      summary: {
        costPrediction: {
          deterministic: {
            contextConfidenceCounts: { contextDetected?: number };
          };
        };
      };
    };
    delete raw.summary.costPrediction.deterministic.contextConfidenceCounts.contextDetected;
    mkdirSync(join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId), { recursive: true });
    writeFileSync(
      join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId, 'summary.json'),
      JSON.stringify(raw),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const sessions = listSessions(tmp);
      expect(sessions).toHaveLength(1);
      const counts = sessions[0]?.summary?.costPrediction?.deterministic?.contextConfidenceCounts;
      expect(counts?.contextDetected).toBe(1);
      expect(String(stderr.mock.calls.flat().join(''))).not.toContain('invalid session');
    } finally {
      stderr.mockRestore();
    }
  });

  it('ignores non-directory entries', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionsRoot = join(tmp, DIPTYCH_DIR, SESSIONS_DIR);
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(join(sessionsRoot, 'notes.txt'), 'not a session');
    writeSessionSubdir(tmp, '2024-01-01-valid', makeSession({ id: '2024-01-01-valid' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-01-valid');
  });
});

describe('listAllSessions', () => {
  it('returns all sessions without limit', () => {
    tmp = createTempDir('sessions-io-test');
    for (let i = 0; i < 15; i++) {
      const id = `2024-01-01-sess-${i}`;
      writeSessionSubdir(tmp, id, makeSession({ id, startedAt: i * 1000 }));
    }

    const sessions = listAllSessions(tmp);
    expect(sessions).toHaveLength(15);
  });
});

describe('listSessions and listAllSessions', () => {
  it('return the same complete session set from one directory', () => {
    tmp = createTempDir('sessions-io-test');
    for (let i = 0; i < 35; i++) {
      const id = `2024-01-01-sess-${i}`;
      writeSessionSubdir(tmp, id, makeSession({ id, startedAt: i * 1000 }));
    }

    const sessions = listSessions(tmp);
    const all = listAllSessions(tmp);

    expect(sessions).toHaveLength(35);
    expect(all).toHaveLength(35);
    expect(sessions[0]?.startedAt).toBe(all[0]?.startedAt);
    expect(sessions[34]?.startedAt).toBe(all[34]?.startedAt);
  });
});

describe('listSessions preserves sessions beyond the previous cap', () => {
  it('retains every session at the old cap boundary', () => {
    tmp = createTempDir('sessions-io-test');
    for (let i = 0; i < 30; i++) {
      const id = `2024-01-01-sess-${i}`;
      writeSessionSubdir(tmp, id, makeSession({ id, startedAt: i * 1000 }));
    }

    expect(listSessions(tmp)).toHaveLength(30);
  });

  it('retains the oldest session when there are 31 stored sessions', () => {
    tmp = createTempDir('sessions-io-test');
    for (let i = 0; i < 31; i++) {
      const id = `2024-01-01-sess-${i}`;
      writeSessionSubdir(tmp, id, makeSession({ id, startedAt: i * 1000 }));
    }

    const out = listSessions(tmp);
    expect(out).toHaveLength(31);
    expect(out.some((s) => s.startedAt === 0)).toBe(true);
    expect(out.some((s) => s.id === '2024-01-01-sess-0')).toBe(true);
    expect(out.some((s) => s.startedAt === 30000)).toBe(true);
  });
});

describe('saveSummary', () => {
  it('writes session summary.json to per-session subdirectory', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-save-1' });
    saveSummary({ projectDir: tmp, sessionId: '2024-01-01-save-1' }, session);
    const raw = readFileSync(
      join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-save-1', 'summary.json'),
      'utf-8',
    );
    expect(JSON.parse(raw)).toEqual(session);
  });

  it('creates directory if it does not exist', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-save-2' });
    saveSummary({ projectDir: tmp, sessionId: '2024-01-01-save-2' }, session);
    const raw = readFileSync(
      join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-save-2', 'summary.json'),
      'utf-8',
    );
    expect(JSON.parse(raw)).toEqual(session);
  });

  it('sets 0o600 file permissions', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-save-3' });
    saveSummary({ projectDir: tmp, sessionId: '2024-01-01-save-3' }, session);
    const stats = statSync(
      join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-save-3', 'summary.json'),
    );
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('validates session data and throws on invalid', () => {
    tmp = createTempDir('sessions-io-test');
    const invalid = { id: 'bad', feature: 123 };
    expect(() => saveSummary({ projectDir: tmp, sessionId: 'bad' }, invalid as never)).toThrow(
      'Invalid session data',
    );
  });

  it('rejects mismatched path id and summary payload id', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-real' });
    expect(() => saveSummary({ projectDir: tmp, sessionId: '2024-01-01-other' }, session)).toThrow(
      "Cannot save session summary for '2024-01-01-other'",
    );
    expect(existsSync(join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-other'))).toBe(false);
  });

  it('rejects invalid session ids', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '../outside' });
    expect(() => saveSummary({ projectDir: tmp, sessionId: '../outside' }, session)).toThrow(
      'Invalid session id',
    );
  });

  it('round-trips through listSessions', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-rt-1', feature: 'roundtrip', startedAt: 5000 });
    saveSummary({ projectDir: tmp, sessionId: '2024-01-01-rt-1' }, session);
    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-01-rt-1');
    expect(sessions[0]?.feature).toBe('roundtrip');
  });

  it('round-trips a summary with multiple taskBreakdown rows', () => {
    tmp = createTempDir('sessions-io-test');
    const id = '2024-01-01-breakdown';
    const firstRow = {
      taskId: taskId('T001'),
      taskTitle: 'first task',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      retryCount: 0,
      tool: 'deepseek',
      model: 'deepseek-chat',
    };
    const secondRow = {
      taskId: taskId('T002'),
      taskTitle: 'second task',
      method: 'local' as const,
      implementerTokens: 300_000,
      escalationTokens: 0,
      retryCount: 0,
      tool: 'deepseek',
      model: 'deepseek-chat',
    };

    const session = makeSession({
      id,
      status: 'complete',
      summary: makeSummary({ taskBreakdown: [firstRow, secondRow] }),
    });
    saveSummary({ projectDir: tmp, sessionId: id }, session);

    const raw = readFileSync(join(tmp, DIPTYCH_DIR, SESSIONS_DIR, id, 'summary.json'), 'utf-8');
    const persisted = JSON.parse(raw) as Session;
    const breakdown = persisted.summary?.taskBreakdown ?? [];
    expect(breakdown.map((row) => row.taskId)).toEqual([taskId('T001'), taskId('T002')]);
    expect(breakdown.find((row) => row.taskId === taskId('T001'))).toMatchObject({
      implementerTokens: 500_000,
      tool: 'deepseek',
    });
  });
});

describe('readSession', () => {
  it('readSession returns the summary saved by saveSummary', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-read-1', feature: 'read-me' });
    saveSummary({ projectDir: tmp, sessionId: '2024-01-01-read-1' }, session);

    expect(readSession({ projectDir: tmp, sessionId: '2024-01-01-read-1' })).toEqual(session);
  });

  it('readSession returns null for a missing or invalid record', () => {
    tmp = createTempDir('sessions-io-test');
    expect(readSession({ projectDir: tmp, sessionId: '2024-01-01-missing' })).toBeNull();

    const badDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-invalid');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'summary.json'), JSON.stringify({ id: 'x' }));
    expect(readSession({ projectDir: tmp, sessionId: '2024-01-01-invalid' })).toBeNull();
  });
});

describe('crashed-run recovery from state.json', () => {
  it('lists a summary-less session that has a state.json as interrupted and resumable', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = '2024-01-01-crashed';
    const state = makeImplState([makeTask()], { feature: 'crashed-feature' });
    saveState({ projectDir: tmp, sessionId }, state);
    expect(existsSync(join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId, 'summary.json'))).toBe(false);

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(sessionId);
    expect(sessions[0]?.feature).toBe('crashed-feature');
    expect(sessions[0]?.status).toBe('interrupted');
    expect(sessions[0]?.summary).toBeNull();

    const recovered = loadState({ projectDir: tmp, sessionId });
    expect(recovered).not.toBeNull();
    expect(recovered && isResumable(recovered)).toBe(true);
  });

  it('prefers summary.json over state.json when both exist', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = '2024-01-01-both';
    saveState({ projectDir: tmp, sessionId }, makeImplState([makeTask()]));
    saveSummary(
      { projectDir: tmp, sessionId },
      makeSession({ id: sessionId, status: 'complete', feature: 'finished' }),
    );

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe('complete');
    expect(sessions[0]?.feature).toBe('finished');
  });

  it('still skips a summary-less directory that has no state.json', () => {
    tmp = createTempDir('sessions-io-test');
    const emptyDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-empty');
    mkdirSync(emptyDir, { recursive: true });

    expect(listSessions(tmp)).toEqual([]);
  });
});
