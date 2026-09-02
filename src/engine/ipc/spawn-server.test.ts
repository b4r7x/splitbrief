import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnServer } from './spawn-server.js';
import {
  createSessionPreparationCandidate,
  prepareNewSession,
  rollbackPreparedSession,
} from '../../core/sessions/prepare.js';
import { transferPreparedSessionToDetached } from '../../core/sessions/detached-handoff.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn as spawnProcess } from 'node:child_process';
import { readActiveRecord } from '../../core/sessions/active-pointer.js';
import { detachedBootstrapRoot, sessionDir } from '../../core/paths.js';

let testDir: string;

function sessionIdFor(dir: string): string {
  return basename(dir);
}

beforeEach(() => {
  testDir = mkdtempSync('/tmp/sb-spawn-');
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('spawnServer', () => {
  it('resolves { ok: false } when the child process emits a spawn error instead of crashing', async () => {
    const savedPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const result = await spawnServer({
        candidate: createSessionPreparationCandidate({
          projectDir: testDir,
          feature: 'test feature',
          persistTranscript: true,
          sessionId: sessionIdFor(testDir),
        }),
        projectDir: testDir,
        feature: 'test feature',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('failed to spawn server');
      }
    } finally {
      process.env['PATH'] = savedPath;
    }
  });
});

function detachedCandidate(projectDir: string, sessionId: string) {
  return createSessionPreparationCandidate({
    projectDir,
    feature: 'detached startup',
    persistTranscript: true,
    sessionId,
  });
}

function prepareDetachedCandidate(
  projectDir: string,
  candidate: ReturnType<typeof detachedCandidate>,
) {
  return prepareNewSession({
    projectDir,
    feature: 'detached startup',
    config: makeConfig(),
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir,
      status: 'ready',
      counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    signal: new AbortController().signal,
    candidate,
  });
}

function fakeChild(pid = 4242): ChildProcess {
  const child = new EventEmitter();
  Object.defineProperties(child, {
    pid: { value: pid },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  Object.assign(child, { unref: () => {} });
  return child as ChildProcess;
}

function fakeSpawn(child: ChildProcess): typeof spawnProcess {
  return (() => child) as typeof spawnProcess;
}

function bootstrapArtifacts(projectDir: string): string[] {
  const root = detachedBootstrapRoot(projectDir);
  return existsSync(root) ? readdirSync(root) : [];
}

describe('detached receipt handoff', () => {
  it('cancellation terminates and waits before rollback without leaving detached artifacts', async () => {
    const candidate = detachedCandidate(testDir, 'cancelled-start');
    const child = fakeChild();
    const cancellation = new AbortController();
    const order: string[] = [];

    const result = await spawnServer(
      {
        candidate,
        projectDir: testDir,
        feature: 'detached startup',
        signal: cancellation.signal,
      },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async ({ signal }) => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared.kind).toBe('prepared');
          order.push('polling');
          cancellation.abort();
          expect(signal?.aborted).toBe(true);
          return { ok: false, reason: 'detached start cancelled' };
        },
        terminateAndWait: async () => {
          order.push('kill');
          await Promise.resolve();
          order.push('wait');
          return true;
        },
        rollback: (session) => {
          order.push('rollback');
          rollbackPreparedSession(session);
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: 'detached start cancelled' });
    expect(order).toEqual(['polling', 'kill', 'wait', 'rollback']);
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
    expect(readActiveRecord(testDir)).toBeNull();
    expect(bootstrapArtifacts(testDir)).toEqual([]);
  });

  it.each(['pre-directory', 'post-creation', 'log-transfer', 'transfer'] as const)(
    'terminates the child and removes bootstrap and final artifacts on a %s startup failure',
    async (stage) => {
      const candidate = detachedCandidate(testDir, `failure-${stage}`);
      const child = fakeChild();
      const order: string[] = [];
      const result = await spawnServer(
        { candidate, projectDir: testDir, feature: 'detached startup' },
        {
          spawnChild: fakeSpawn(child),
          waitForPrepared: async () => {
            if (stage !== 'pre-directory') {
              const prepared = prepareDetachedCandidate(testDir, candidate);
              expect(prepared.kind).toBe('prepared');
              if (stage === 'log-transfer') {
                writeFileSync(
                  join(sessionDir(testDir, candidate.sessionId), 'server.log'),
                  'conflicting log',
                );
              }
            }
            order.push('failed');
            return stage === 'transfer' || stage === 'log-transfer'
              ? { ok: true, pid: 4242, sessionId: candidate.sessionId, authToken: 'auth' }
              : { ok: false, reason: 'startup failed' };
          },
          terminateAndWait: async () => {
            order.push('kill');
            await Promise.resolve();
            order.push('wait');
            return true;
          },
          ...(stage === 'transfer' && {
            acceptServer: async () => {
              order.push('parent-accept');
              return { ok: true, pid: 4242, sessionId: candidate.sessionId };
            },
            transfer: () => {
              order.push('transfer-failed');
              throw new Error('transfer failed');
            },
          }),
          rollback: (session) => {
            order.push('rollback');
            rollbackPreparedSession(session);
          },
        },
      );

      expect(result.ok).toBe(false);
      expect(order).toEqual(
        stage === 'transfer'
          ? ['failed', 'parent-accept', 'transfer-failed', 'kill', 'wait', 'rollback']
          : ['failed', 'kill', 'wait', 'rollback'],
      );
      expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
      expect(bootstrapArtifacts(testDir)).toEqual([]);
    },
  );

  it('preserves owned state when child termination cannot be confirmed', async () => {
    const candidate = detachedCandidate(testDir, 'unconfirmed-child');
    const child = fakeChild();
    const order: string[] = [];

    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared.kind).toBe('prepared');
          order.push('failed');
          return { ok: false, reason: 'startup rejected' };
        },
        terminateAndWait: async () => {
          order.push('termination-unconfirmed');
          return false;
        },
        rollback: () => {
          order.push('rollback');
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'startup rejected; child termination could not be confirmed',
    });
    expect(order).toEqual(['failed', 'termination-unconfirmed']);
    expect(readActiveRecord(testDir)).toEqual({ kind: 'v1', receipt: candidate });
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(true);
    expect(bootstrapArtifacts(testDir)).not.toEqual([]);
  });

  it('removes the exact candidate session when the child dies after creation before acknowledgement', async () => {
    const candidate = detachedCandidate(testDir, 'dies-before-ack');
    const child = fakeChild();

    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared.kind).toBe('prepared');
          return { ok: false, reason: 'child exited before acknowledgement' };
        },
        terminateAndWait: async () => true,
      },
    );

    expect(result.ok).toBe(false);
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
  });

  it('uses the detached candidate generation as the initial active receipt and rolls back a pre-ack child death', async () => {
    const candidate = detachedCandidate(testDir, 'candidate-active');
    const child = fakeChild();

    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared).toMatchObject({
            kind: 'prepared',
            session: { ownership: candidate, active: candidate },
          });
          expect(readActiveRecord(testDir)).toEqual({ kind: 'v1', receipt: candidate });
          return { ok: false, reason: 'child died before ack' };
        },
        terminateAndWait: async () => true,
      },
    );

    expect(result.ok).toBe(false);
    expect(readActiveRecord(testDir)).toBeNull();
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
  });

  it('parent transfers ownership only after exact response and socket acceptance', async () => {
    const candidate = detachedCandidate(testDir, 'parent-release');
    const child = fakeChild();
    const order: string[] = [];
    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared.kind).toBe('prepared');
          order.push('response');
          order.push('socket');
          return { ok: true, pid: 4242, sessionId: candidate.sessionId, authToken: 'auth' };
        },
        acceptServer: async () => {
          order.push('parent-accept');
          return { ok: true, pid: 4242, sessionId: candidate.sessionId };
        },
        transfer: (session) => {
          order.push('parent-transfer');
          transferPreparedSessionToDetached(session);
        },
      },
    );

    expect(result).toEqual({ ok: true, pid: 4242, sessionId: candidate.sessionId });
    expect(order).toEqual(['response', 'socket', 'parent-accept', 'parent-transfer']);
    expect(existsSync(join(sessionDir(testDir, candidate.sessionId), '.prepare-owner.json'))).toBe(
      true,
    );
    expect(
      existsSync(join(sessionDir(testDir, candidate.sessionId), '.detached-handoff.json')),
    ).toBe(true);
  });

  it('keeps parent rollback authority when the acceptance ACK cannot be confirmed', async () => {
    const candidate = detachedCandidate(testDir, 'ack-write-failure');
    const child = fakeChild();
    const order: string[] = [];

    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared.kind).toBe('prepared');
          return { ok: true, pid: 4242, sessionId: candidate.sessionId, authToken: 'auth' };
        },
        acceptServer: async () => {
          order.push('ack-failed');
          return { ok: false, reason: 'parent acceptance ACK was not flushed' };
        },
        transfer: () => {
          order.push('transfer');
        },
        terminateAndWait: async () => {
          order.push('terminate');
          return true;
        },
        rollback: (session) => {
          order.push('rollback');
          rollbackPreparedSession(session);
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: 'parent acceptance ACK was not flushed' });
    expect(order).toEqual(['ack-failed', 'terminate', 'rollback']);
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
  });

  it('cancels after acceptance and before ownership transfer', async () => {
    const candidate = detachedCandidate(testDir, 'cancel-after-acceptance');
    const child = fakeChild();
    const cancellation = new AbortController();
    const order: string[] = [];

    const result = await spawnServer(
      {
        candidate,
        projectDir: testDir,
        feature: 'detached startup',
        signal: cancellation.signal,
      },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => {
          const prepared = prepareDetachedCandidate(testDir, candidate);
          expect(prepared.kind).toBe('prepared');
          return { ok: true, pid: 4242, sessionId: candidate.sessionId, authToken: 'auth' };
        },
        acceptServer: async () => {
          order.push('accepted');
          cancellation.abort();
          return { ok: true, pid: 4242, sessionId: candidate.sessionId };
        },
        transfer: () => {
          order.push('transfer');
        },
        terminateAndWait: async () => {
          order.push('terminate');
          return true;
        },
        rollback: (session) => {
          order.push('rollback');
          rollbackPreparedSession(session);
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: 'detached start cancelled' });
    expect(order).toEqual(['accepted', 'terminate', 'rollback']);
    expect(readActiveRecord(testDir)).toBeNull();
    expect(existsSync(sessionDir(testDir, candidate.sessionId))).toBe(false);
    expect(bootstrapArtifacts(testDir)).toEqual([]);
  });

  it('removes the bootstrap even when receipt-aware rollback fails', async () => {
    const candidate = detachedCandidate(testDir, 'rollback-failure');
    const child = fakeChild();

    const result = await spawnServer(
      { candidate, projectDir: testDir, feature: 'detached startup' },
      {
        spawnChild: fakeSpawn(child),
        waitForPrepared: async () => ({ ok: false, reason: 'startup rejected' }),
        terminateAndWait: async () => true,
        rollback: () => {
          throw new Error('rollback failed');
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'startup rejected; startup rollback failed',
    });
    expect(bootstrapArtifacts(testDir)).toEqual([]);
  });
});
