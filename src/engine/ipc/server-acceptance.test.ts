import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionDir } from '../../core/paths.js';
import { readActive } from '../../core/sessions/active-pointer.js';
import {
  acceptDetachedSessionHandoff,
  settleDetachedSessionHandoff,
} from '../../core/sessions/detached-handoff.js';
import { prepareNewSession } from '../../core/sessions/prepare.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createParentAcceptanceBarrier } from './server-acceptance.js';

describe('detached parent acceptance barrier', () => {
  it('fails promptly when the parent process dies before acceptance', async () => {
    const barrier = createParentAcceptanceBarrier({
      candidate: {
        version: 1,
        sessionId: 'parent-died',
        generation: '12345678-1234-4123-8123-123456789abc',
      },
      parentPid: 99_999_999,
      childPid: process.pid,
      timeoutMs: 5_000,
      acceptHandoff: () => false,
      settleHandoff: () => 'rolled-back',
    });

    await expect(barrier.wait()).rejects.toMatchObject({ kind: 'detached-parent-exited' });
  });

  it('does not treat the socket ACK as authoritative when the parent dies before handoff', async () => {
    const candidate = {
      version: 1 as const,
      sessionId: 'handoff-parent-exit',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const barrier = createParentAcceptanceBarrier({
      candidate,
      parentPid: 99_999_999,
      childPid: process.pid,
      timeoutMs: 1_000,
      acceptHandoff: () => false,
      settleHandoff: () => 'rolled-back',
    });

    expect(barrier.accept({ ...candidate, childPid: process.pid })).toBe(true);
    await expect(barrier.wait()).rejects.toMatchObject({
      kind: 'detached-parent-exited',
    });
  });

  it('closes the barrier after timing out before socket acceptance', async () => {
    const candidate = {
      version: 1 as const,
      sessionId: 'acceptance-timeout',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const barrier = createParentAcceptanceBarrier({
      candidate,
      parentPid: process.pid,
      childPid: process.pid,
      timeoutMs: 0,
      acceptHandoff: () => false,
      settleHandoff: () => 'rolled-back',
    });

    await expect(barrier.wait()).rejects.toMatchObject({
      kind: 'detached-parent-acceptance-timeout',
    });
    expect(barrier.accept({ ...candidate, childPid: process.pid })).toBe(false);
  });

  it('accepts a durable handoff even when the parent exits immediately afterward', async () => {
    const candidate = {
      version: 1 as const,
      sessionId: 'handoff-before-parent-exit',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const barrier = createParentAcceptanceBarrier({
      candidate,
      parentPid: 99_999_999,
      childPid: process.pid,
      timeoutMs: 1_000,
      acceptHandoff: () => true,
      settleHandoff: () => 'accepted',
    });

    expect(barrier.accept({ ...candidate, childPid: process.pid })).toBe(true);
    await expect(barrier.wait()).resolves.toBeUndefined();
  });

  it('rejects an ACK that arrives after the deadline before the event-loop poll runs', async () => {
    const candidate = {
      version: 1 as const,
      sessionId: 'late-acceptance',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const barrier = createParentAcceptanceBarrier({
      candidate,
      parentPid: process.pid,
      childPid: process.pid,
      timeoutMs: 1,
      acceptHandoff: () => false,
      settleHandoff: () => 'rolled-back',
    });
    const waiting = barrier.wait();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);

    expect(barrier.accept({ ...candidate, childPid: process.pid })).toBe(false);
    await expect(waiting).rejects.toMatchObject({ kind: 'detached-parent-acceptance-timeout' });
  });

  it('bounds the post-ACK wait and rolls back before rejecting', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'server-entry-handoff-timeout-'));
    const candidate = {
      version: 1 as const,
      sessionId: '2026-08-04-handoff-timeout',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const prepared = prepareNewSession({
      projectDir,
      feature: 'bounded detached handoff',
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
      candidate,
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    let ran = false;
    const barrier = createParentAcceptanceBarrier({
      candidate,
      parentPid: process.pid,
      childPid: process.pid,
      timeoutMs: 1,
      acceptHandoff: () => acceptDetachedSessionHandoff(prepared.session),
      settleHandoff: () => settleDetachedSessionHandoff(prepared.session),
    });

    expect(barrier.accept({ ...candidate, childPid: process.pid })).toBe(true);
    const guardedRun = barrier.wait().then(() => {
      ran = true;
    });

    await expect(guardedRun).rejects.toMatchObject({ kind: 'detached-parent-acceptance-timeout' });
    expect(ran).toBe(false);
    expect(existsSync(sessionDir(projectDir, candidate.sessionId))).toBe(false);
    expect(readActive(projectDir)).toBeNull();
    rmSync(projectDir, { recursive: true, force: true });
  });
});
