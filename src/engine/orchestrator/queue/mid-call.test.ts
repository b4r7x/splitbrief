import { describe, expect, it, vi } from 'vitest';
import { enableDebugLog, loggedDiagnostics } from '#testing/helpers/debug-log.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { settleMidCallDeliveries, trackMidCallDelivery } from './mid-call.js';
import { resetLoggerForTests } from '../../../lib/logger.js';
import { installDiagnosticSink } from '../../../lib/warn.js';

describe('settleMidCallDeliveries', () => {
  it('waits for outcome persistence and deliveries registered while waiting', async () => {
    const ref = { projectDir: '/registry-test', sessionId: 'all-deliveries' };
    const first = Promise.withResolvers<void>();
    const persisted = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    trackMidCallDelivery(
      ref,
      'first',
      first.promise.then(() => persisted.promise),
    );
    let settled = false;
    const settling = settleMidCallDeliveries(ref).then(() => {
      settled = true;
    });

    first.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    trackMidCallDelivery(ref, 'second', second.promise);
    persisted.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    second.resolve();
    await settling;
    expect(settled).toBe(true);
    await settleMidCallDeliveries(ref);
  });

  it('logs a stopped delivery failure without failing a continued run or waiting for another run', async () => {
    const ref = { projectDir: '/registry-test', sessionId: 'failure' };
    const other = { ...ref, sessionId: 'other' };
    const pending = Promise.withResolvers<void>();
    trackMidCallDelivery(other, 'other', pending.promise);
    const failure = new Error('outcome persistence failed');
    const logDir = createTempDir('mid-call-log');
    enableDebugLog(logDir);
    const logged = () => loggedDiagnostics(logDir).filter((line) => line.includes(failure.message));
    const warnings: string[] = [];
    const removeSink = installDiagnosticSink((message) => warnings.push(message));
    try {
      trackMidCallDelivery(ref, 'failed', Promise.reject(failure));
      await vi.waitFor(() => expect(logged()).toHaveLength(1));
      expect(warnings).toEqual([]);
      trackMidCallDelivery(ref, 'continued', Promise.resolve());
      await expect(settleMidCallDeliveries(ref)).resolves.toBeUndefined();
      expect(logged()).toHaveLength(1);
      expect(warnings).toEqual([]);
    } finally {
      removeSink();
      pending.resolve();
      await settleMidCallDeliveries(other);
      resetLoggerForTests();
      cleanupTempDir(logDir);
    }
  });
});
