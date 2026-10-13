import { expect, it } from 'vitest';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { EngineEventOf } from '../../../src/engine/events/types.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  continueRun,
  createStopContinueFixture,
  endImplementerHold,
  readState,
  startAndSignal,
} from '../helpers/stop-continue-fixture.js';

it('records distinct runner calls when another CLI process continues a stopped brief', async () => {
  const target = createStopContinueFixture(undefined, { isolation: 'none' });
  try {
    const stopped = await startAndSignal(target, 'SIGINT', target.projectDir);
    expect(stopped.exitCode, stopped.stdout).toBe(0);
    const ref = { projectDir: target.projectDir, sessionId: stopped.sessionId };
    const before = (await readRunEvents(ref)).events.filter(
      (event): event is EngineEventOf<'runner_call_started'> =>
        event.type === 'runner_call_started' && event.role === 'implementer',
    );
    expect(before).toHaveLength(1);

    const continued = await continueRun(target);

    expect(continued.exitCode, continued.stderr).toBe(0);
    expect(readState(target, stopped.sessionId).phase).toBe('complete');
    const { events } = await readRunEvents(ref);
    const calls = events.filter((event) => event.type === 'runner_call_started');
    const implementerCalls = calls.filter((event) => event.role === 'implementer');
    expect(implementerCalls).toHaveLength(2);
    expect(implementerCalls[0]?.callId).toBe(before[0]?.callId);
    expect(implementerCalls[1]?.callId).not.toBe(before[0]?.callId);
    for (const role of ['planner', 'review']) {
      const seatCalls = calls.filter((event) => event.role === role);
      expect(seatCalls.length).toBeGreaterThan(0);
      for (const call of seatCalls) expect(call.callId).toMatch(new RegExp(`^${role}-`));
    }
    expect(new Set(calls.map((event) => event.callId)).size).toBe(calls.length);
  } finally {
    await endImplementerHold(target);
    cleanupTempDir(target.tmpDir);
  }
});
