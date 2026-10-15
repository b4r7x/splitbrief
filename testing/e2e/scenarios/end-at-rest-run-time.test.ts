import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  endImplementerHold,
  readState,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const DAY = 24 * 60 * 60_000;

let fixture: StopContinueFixture | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
});

it('records how long a killed run ran when it is ended at rest days later', {
  timeout: 240_000,
}, async () => {
  fixture = createStopContinueFixture();
  const target = fixture;
  const killed = await startAndSignal(target, 'SIGKILL', target.isolationTreesDir);
  expect(killed.exitCode).toBeNull();
  const ref = { projectDir: target.projectDir, sessionId: killed.sessionId };

  // The End comes three days after the kill.
  const preload = join(target.tmpDir, 'later.mjs');
  writeFileSync(preload, `const wallNow = Date.now;\nDate.now = () => wallNow() + ${3 * DAY};\n`);
  vi.stubEnv('NODE_OPTIONS', `--import=${preload}`);
  const ended = await cli(target, ['continue', killed.sessionId, '--action', 'end-run']);
  expect(ended.exitCode, ended.stderr).toBe(0);
  expect(readState(target, killed.sessionId).closed?.as).toBe('ended');

  const { events } = await readRunEvents(ref);
  const started = events.find((event) => event.type === 'workflow_started');
  const cancel = events.find((event) => event.type === 'workflow_cancelled');
  const closedAt = events.find((event) => event.type === 'workspace_closed')?.ts;
  if (started === undefined || cancel?.type !== 'workflow_cancelled' || closedAt === undefined) {
    throw new Error(`Run did not end at rest: ${events.map((event) => event.type).join(', ')}`);
  }
  const atRestFrom = cancel.atRestFrom;
  if (atRestFrom === undefined) throw new Error('The End at rest is not marked on its cancel');
  // What the End wrote is dated three days on; the killed process's own marks are not.
  expect(closedAt - started.ts).toBeGreaterThan(3 * DAY);
  const lastOfKilled = Math.max(
    ...events.filter((event) => event.ts < atRestFrom).map((event) => event.ts),
  );

  const activeTime = readRunRecord(ref).summary?.activeTime;
  expect(activeTime).toBe(lastOfKilled - started.ts);
  expect(activeTime).toBeLessThan(DAY);
});
